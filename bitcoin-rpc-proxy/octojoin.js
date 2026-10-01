// Octojoin transaction construction. Pure functions, satoshis only: BTC decimals
// are used at the RPC boundary in server.js and nowhere else.

import { createHash, randomBytes } from 'node:crypto';

export const MIN_INPUTS = 3;
export const MIN_OUTPUTS = 2;
export const TX_OVERHEAD_VBYTES = 11;
export const OCTOJOIN_LABEL = 'octojoin';
export const ROUND_UNIT = 1000;
export const SPLIT_ATTEMPTS = 10000;
export const MAX_SELECTIONS = 200000;

export const UNNECESSARY_INPUT = 'unnecessaryInput';
export const CHANGE_IDENTIFIABLE = 'changeIdentifiable';
export const WARNINGS = {
    [UNNECESSARY_INPUT]:
        'No choice of coins avoids an unnecessary input. The change is larger than one of the inputs, ' +
        'which tells an observer that this is not a simple payment.',
    [CHANGE_IDENTIFIABLE]:
        'No choice of coins gives change that blends in with the payment outputs, ' +
        'so an observer could tell the change apart.',
};

// Uniform integers from SHA-256 of a secret seed and a counter. A seed gives
// the same plan here and in the Electrum plugin, which tests use to compare them.
export class Randomness {
    constructor(seed = randomBytes(32)) {
        this.seed = Buffer.from(seed);
        this.counter = 0n;
    }

    below(n) {
        const range = BigInt(n);
        const limit = (1n << 64n) - ((1n << 64n) % range);
        for (;;) {
            this.counter += 1n;
            const counter = Buffer.alloc(8);
            counter.writeBigUInt64BE(this.counter);
            const value = createHash('sha256').update(this.seed).update(counter).digest().readBigUInt64BE(0);
            if (value < limit) return Number(value % range);
        }
    }
}

export function isOctojoinLabel(label) {
    return typeof label === 'string' && label.toLowerCase().includes(OCTOJOIN_LABEL);
}

function isWitnessProgram(spk) {
    const bytes = spk.length / 2;
    if (bytes < 4 || bytes > 42) return false;
    const version = parseInt(spk.slice(0, 2), 16);
    if (version !== 0x00 && (version < 0x51 || version > 0x60)) return false;
    const push = parseInt(spk.slice(2, 4), 16);
    return push >= 2 && push <= 40 && push + 2 === bytes;
}

export function outputVbytes(spk) {
    return 9 + spk.length / 2;
}

// Bitcoin Core's dust rule at the default dust relay fee of 3000 sat/kvB: an
// output is dust when spending it would cost more than a third of its value.
export function dustThreshold(spk) {
    return 3 * (outputVbytes(spk) + (isWitnessProgram(spk) ? 67 : 148));
}

export function inputVbytes(spk) {
    const s = spk.toLowerCase();
    if (s.startsWith('0014') && s.length === 44) return 68;
    if (s.startsWith('5120') && s.length === 68) return 58;
    if (s.startsWith('0020') && s.length === 68) return 105;
    if (s.startsWith('a914') && s.endsWith('87') && s.length === 46) return 91;
    return 148;
}

export function scriptType(spk) {
    const s = spk.toLowerCase();
    if (s.startsWith('0014') && s.length === 44) return 'bech32';
    if (s.startsWith('5120') && s.length === 68) return 'bech32m';
    if (s.startsWith('a914') && s.endsWith('87') && s.length === 46) return 'p2sh-segwit';
    if (s.startsWith('76a914') && s.endsWith('88ac')) return 'legacy';
    return 'other';
}

export function estimateFee({ inputScripts, outputScripts, feeRate }) {
    const vsize =
        TX_OVERHEAD_VBYTES +
        inputScripts.reduce((sum, spk) => sum + inputVbytes(spk), 0) +
        outputScripts.reduce((sum, spk) => sum + outputVbytes(spk), 0);
    return Math.ceil(vsize * feeRate);
}

export function isRound(valueSats) {
    return valueSats % ROUND_UNIT === 0;
}

function divFloor(a, b) {
    return (a - (a % b)) / b;
}

// The smallest and largest value of a payment output: above dust, and between
// half and one and a half times an even share of the payment.
export function splitRange(paymentSats, numOutputs, dust) {
    const share = 2 * numOutputs;
    const lo = divFloor(paymentSats, share) + (paymentSats % share ? 1 : 0);
    return [Math.max(dust + 1, lo), divFloor(3 * paymentSats, share)];
}

export function smallestSplittable(numOutputs, dust) {
    return numOutputs * (dust + 1) + (numOutputs * (numOutputs - 1)) / 2;
}

// Cut the payment at random points into values in the split range that are all
// different, not round and not equal to the change. With below, at least one of
// them is smaller than it. Returns null if no attempt gives such values.
export function splitAmount(paymentSats, numOutputs, dust, rng, { changeSats = 0, below = null } = {}) {
    const [lo, hi] = splitRange(paymentSats, numOutputs, dust);
    const spread = paymentSats - numOutputs * lo;
    if (spread < 0) return null;
    for (let attempt = 0; attempt < SPLIT_ATTEMPTS; attempt++) {
        const draws = [];
        for (let i = 0; i < numOutputs - 1; i++) draws.push(rng.below(spread + 1));
        const cuts = draws.sort((a, b) => a - b);
        const lower = [0, ...cuts];
        const values = [...cuts, spread].map((upper, i) => lo + upper - lower[i]);
        if (
            Math.max(...values) <= hi &&
            new Set(values).size === numOutputs &&
            !values.includes(changeSats) &&
            !values.some(isRound) &&
            (below === null || Math.min(...values) < below)
        ) {
            return values;
        }
    }
    return null;
}

export function chooseCombinations(items, k) {
    if (k === 0) return [[]];
    if (k > items.length) return [];
    const result = [];
    for (let i = 0; i <= items.length - k; i++) {
        for (const rest of chooseCombinations(items.slice(i + 1), k - 1)) {
            result.push([items[i], ...rest]);
        }
    }
    return result;
}

function countCombinations(n, k) {
    let count = 1;
    for (let i = 1; i <= k; i++) count = (count * (n - k + i)) / i;
    return count;
}

function fund(inputs, paymentSats, paymentScripts, changeSpk, feeRate, changeDust) {
    const total = inputs.reduce((sum, u) => sum + u.valueSats, 0);
    const inputScripts = inputs.map(u => u.spk);
    let feeSats = estimateFee({ inputScripts, outputScripts: [...paymentScripts, changeSpk], feeRate });
    let changeSats = total - paymentSats - feeSats;
    if (changeSats > changeDust && isRound(changeSats)) {
        changeSats -= 1;
        feeSats += 1;
    }
    if (changeSats <= changeDust) {
        // no viable change output: the remainder becomes fee, which also removes
        // the change output an observer could identify
        changeSats = 0;
        feeSats = total - paymentSats;
        if (feeSats < estimateFee({ inputScripts, outputScripts: paymentScripts, feeRate })) return null;
    }
    return { inputs, total, changeSats, feeSats, minInput: Math.min(...inputs.map(u => u.valueSats)) };
}

// Select (numInputs - 1) swapped coins plus exactly one sender coin. The change
// should be smaller than the smallest input, otherwise an input could be dropped
// while the payment is still funded - the unnecessary input heuristic
// (https://eprint.iacr.org/2022/589.pdf). It should also lie in the split range,
// so that it looks like one of the payment outputs. Pick at random among the
// selections that do best on both. Returns null when no selection funds the
// payment.
export function selectInputs({
    swapped, other, numInputs, paymentSats, paymentScripts, changeSpk, feeRate, changeDust, split, rng,
}) {
    const numSwapped = numInputs - 1;
    if (swapped.length < numSwapped || other.length < 1) return null;
    const senders = [...other].sort((a, b) => a.valueSats - b.valueSats);
    let pool = [...swapped].sort((a, b) => a.valueSats - b.valueSats);
    let extra = 6;
    while (extra && countCombinations(Math.min(pool.length, numSwapped + extra), numSwapped) * senders.length > MAX_SELECTIONS) {
        extra -= 1;
    }
    pool = pool.slice(0, numSwapped + extra);
    const [lo, hi] = split;
    let bestRank = null;
    let best = [];
    for (const combo of chooseCombinations(pool, numSwapped)) {
        for (const sender of senders) {
            const selection = fund([...combo, sender], paymentSats, paymentScripts, changeSpk, feeRate, changeDust);
            if (!selection) continue;
            const { changeSats } = selection;
            const unnecessary = changeSats >= selection.minInput;
            const outOfRange = changeSats > 0 && !(lo <= changeSats && changeSats <= hi);
            const rank = (unnecessary ? 2 : 0) + (outOfRange ? 1 : 0);
            if (bestRank === null || rank < bestRank) {
                bestRank = rank;
                best = [selection];
            } else if (rank === bestRank) {
                best.push(selection);
            }
        }
    }
    return best.length ? best[rng.below(best.length)] : null;
}

export class OctojoinError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export function planOctojoin({
    utxos, paymentSats, outputs, numInputs, numOutputs, feeRate, changeSpk, rng = new Randomness(),
}) {
    if (numInputs < MIN_INPUTS) {
        throw new OctojoinError('inputsTooLow', `Number of inputs must be at least ${MIN_INPUTS}`);
    }
    if (numOutputs < MIN_OUTPUTS) {
        throw new OctojoinError('outputsTooLow', `Number of outputs must be at least ${MIN_OUTPUTS}`);
    }
    if (outputs.length !== numOutputs) {
        throw new OctojoinError(
            'outputsMismatch',
            `Provide exactly ${numOutputs} output addresses, found ${outputs.length}`,
        );
    }

    const dust = Math.max(...outputs.map(o => dustThreshold(o.spk)));
    if (paymentSats <= dust) {
        throw new OctojoinError('amountBelowDust', `Payment of ${paymentSats} sat is below the dust threshold of ${dust} sat`);
    }
    const tooSmall = () => new OctojoinError(
        'outputBelowDust',
        `${paymentSats} sat cannot be split into ${numOutputs} different outputs above the dust threshold of ${dust} sat. Lower the number of outputs or raise the amount.`,
    );
    if (paymentSats < smallestSplittable(numOutputs, dust)) throw tooSmall();

    const swapped = utxos.filter(u => u.isSwapped);
    const other = utxos.filter(u => !u.isSwapped);
    const requiredSwapped = numInputs - 1;
    if (swapped.length < requiredSwapped) {
        throw new OctojoinError(
            'notEnoughSwappedCoins',
            `Need at least ${requiredSwapped} swapped coins labeled '${OCTOJOIN_LABEL}', found ${swapped.length}`,
        );
    }
    if (other.length < 1) {
        throw new OctojoinError('noSenderCoin', 'Need at least 1 coin that is not labeled octojoin');
    }

    const split = splitRange(paymentSats, numOutputs, dust);
    const selection = selectInputs({
        swapped,
        other,
        numInputs,
        paymentSats,
        paymentScripts: outputs.map(o => o.spk),
        changeSpk,
        feeRate,
        changeDust: dustThreshold(changeSpk),
        split,
        rng,
    });
    if (!selection) {
        throw new OctojoinError(
            'insufficientFunds',
            'Could not fund the payment from the swapped coins plus a single sender coin. Use larger coins or lower the amount.',
        );
    }

    const { changeSats, minInput } = selection;
    // with change below every input, a payment output below every input as well
    // keeps the change from being the only output the heuristic points to
    const below = changeSats && changeSats < minInput && minInput > split[0] ? minInput : null;
    let values = splitAmount(paymentSats, numOutputs, dust, rng, { changeSats, below });
    if (!values && below !== null) values = splitAmount(paymentSats, numOutputs, dust, rng, { changeSats });
    if (!values) throw tooSmall();

    const [lo, hi] = split;
    const uihClean = changeSats < minInput;
    const changeHidden =
        changeSats === 0 ||
        (lo <= changeSats && changeSats <= hi && (changeSats >= minInput || Math.min(...values) < minInput));
    return {
        inputs: selection.inputs,
        paymentTargets: outputs.map((output, i) => ({ address: output.address, spk: output.spk, valueSats: values[i] })),
        changeSats,
        feeSats: selection.feeSats,
        totalInputSats: selection.total,
        uihClean,
        changeHidden,
        warnings: [
            ...(uihClean ? [] : [UNNECESSARY_INPUT]),
            ...(changeHidden ? [] : [CHANGE_IDENTIFIABLE]),
        ],
    };
}
