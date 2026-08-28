// Octojoin transaction construction. Pure functions, satoshis only: BTC decimals
// are used at the RPC boundary in server.js and nowhere else.

export const STANDARD_DENOMINATIONS = [
    100000000, 50000000, 20000000, 10000000, 5000000, 2000000, 1000000, 500000, 200000, 100000,
];

export const MIN_INPUTS = 3;
export const MIN_OUTPUTS = 2;
export const TX_OVERHEAD_VBYTES = 11;
export const OCTOJOIN_LABEL = 'octojoin';

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

export function decomposeAmount(amountSats, dust) {
    const denominations = [];
    let remaining = amountSats;

    for (const denom of STANDARD_DENOMINATIONS) {
        while (remaining >= denom) {
            denominations.push(denom);
            remaining -= denom;
        }
    }

    if (remaining > dust) {
        denominations.push(remaining);
    } else if (remaining > 0 && denominations.length > 0) {
        denominations[denominations.length - 1] += remaining;
    }

    return denominations;
}

// A payment like 0.002 BTC decomposes to a single standard denomination and
// cannot fill the requested outputs on its own. Split the largest value into
// smaller standard denominations until there are enough, which keeps the sum and
// the standard denominations intact.
const DENOMINATION_SPLITS = new Map([
    [100000000, [50000000, 50000000]],
    [50000000, [20000000, 20000000, 10000000]],
    [20000000, [10000000, 10000000]],
    [10000000, [5000000, 5000000]],
    [5000000, [2000000, 2000000, 1000000]],
    [2000000, [1000000, 1000000]],
    [1000000, [500000, 500000]],
    [500000, [200000, 200000, 100000]],
    [200000, [100000, 100000]],
]);

function splitValue(value, dust) {
    const standard = DENOMINATION_SPLITS.get(value);
    if (standard) return standard;
    const half = Math.floor(value / 2);
    const rest = value - half;
    if (half > dust) return [rest, half];
    return null;
}

export function splitToFill(denominations, numOutputs, dust) {
    const values = [...denominations];
    while (values.length < numOutputs) {
        let index = -1;
        let split = null;
        for (let i = 0; i < values.length; i++) {
            if (index >= 0 && values[i] <= values[index]) continue;
            const candidate = splitValue(values[i], dust);
            if (candidate) {
                index = i;
                split = candidate;
            }
        }
        if (index < 0) return values;
        values.splice(index, 1, ...split);
    }
    return values;
}

export function bucketValues(values, numBuckets) {
    const buckets = new Array(numBuckets).fill(0);
    values.forEach((value, i) => {
        buckets[i % numBuckets] += value;
    });
    return buckets;
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

// Select (numInputs - 1) swapped decoys plus exactly one sender coin so that the
// change is smaller than the smallest input. Otherwise an input could be dropped
// while the payment is still funded - the unnecessary input heuristic - which
// fingerprints the transaction (https://eprint.iacr.org/2022/589.pdf). Prefer a
// clean selection, then the smallest change. Returns null when no funding
// selection exists.
export function selectUTXOs(swappedUTXOs, otherUTXOs, numInputs, targetSats) {
    const numSwapped = numInputs - 1;
    if (swappedUTXOs.length < numSwapped || otherUTXOs.length < 1) return null;

    const swappedPool = [...swappedUTXOs].sort((a, b) => a.valueSats - b.valueSats).slice(0, numSwapped + 6);
    const senders = [...otherUTXOs].sort((a, b) => a.valueSats - b.valueSats).slice(0, 10);

    let best = null;
    for (const combo of chooseCombinations(swappedPool, numSwapped)) {
        const swappedValue = combo.reduce((sum, u) => sum + u.valueSats, 0);
        for (const sender of senders) {
            const total = swappedValue + sender.valueSats;
            if (total < targetSats) continue;
            const change = total - targetSats;
            const minInput = Math.min(sender.valueSats, ...combo.map(u => u.valueSats));
            const clean = change < minInput;
            if (!best || (clean && !best.clean) || (clean === best.clean && change < best.change)) {
                best = { swapped: combo, other: sender, total, change, clean };
            }
        }
    }
    return best;
}

export class OctojoinError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export function planOctojoin({ utxos, paymentSats, outputs, numInputs, numOutputs, feeRate, changeSpk }) {
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
    const denominations = decomposeAmount(paymentSats, dust);
    if (denominations.length === 0) {
        throw new OctojoinError('amountBelowDust', `Payment of ${paymentSats} sat is below the dust threshold of ${dust} sat`);
    }
    const filled = splitToFill(denominations, numOutputs, dust);
    if (filled.length < numOutputs) {
        throw new OctojoinError(
            'tooFewDenominations',
            `${paymentSats} sat cannot be split into ${numOutputs} outputs above the dust threshold. Lower the number of outputs or raise the amount.`,
        );
    }

    const buckets = bucketValues(filled, numOutputs);
    const paymentTargets = outputs.map((output, i) => ({ address: output.address, spk: output.spk, valueSats: buckets[i] }));
    for (const target of paymentTargets) {
        if (target.valueSats <= dustThreshold(target.spk)) {
            throw new OctojoinError('outputBelowDust', `Output of ${target.valueSats} sat to ${target.address} is dust`);
        }
    }

    const paymentScripts = paymentTargets.map(t => t.spk);
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

    const worstInputSpk = [...utxos].sort((a, b) => inputVbytes(b.spk) - inputVbytes(a.spk))[0].spk;
    const roughFee = estimateFee({
        inputScripts: new Array(numInputs).fill(worstInputSpk),
        outputScripts: [...paymentScripts, changeSpk],
        feeRate,
    });

    const selection = selectUTXOs(swapped, other, numInputs, paymentSats + roughFee);
    if (!selection) {
        throw new OctojoinError(
            'insufficientFunds',
            'Could not fund the payment from the swapped decoys plus a single sender coin. Use larger coins or lower the amount.',
        );
    }

    const inputs = [...selection.swapped, selection.other];
    const inputScripts = inputs.map(u => u.spk);
    const totalInputSats = selection.total;

    const feeWithChange = estimateFee({ inputScripts, outputScripts: [...paymentScripts, changeSpk], feeRate });
    const feeWithoutChange = estimateFee({ inputScripts, outputScripts: paymentScripts, feeRate });

    let changeSats = totalInputSats - paymentSats - feeWithChange;
    let feeSats = feeWithChange;

    if (changeSats <= dustThreshold(changeSpk)) {
        // no viable change output: the remainder becomes fee, which also removes
        // the change output an observer could identify
        feeSats = totalInputSats - paymentSats;
        changeSats = 0;
        if (feeSats < feeWithoutChange) {
            throw new OctojoinError(
                'insufficientFunds',
                'Selected coins cannot cover the payment and fee. Use larger coins or lower the fee rate.',
            );
        }
    }

    const minInput = Math.min(...inputs.map(u => u.valueSats));
    return {
        inputs,
        paymentTargets,
        denominations: filled,
        changeSats,
        feeSats,
        totalInputSats,
        uihClean: changeSats === 0 || changeSats < minInput,
    };
}
