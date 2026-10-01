import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    CHANGE_BESIDE_EQUAL_OUTPUTS,
    CHANGE_IDENTIFIABLE,
    Randomness,
    UNNECESSARY_INPUT,
    dustThreshold,
    equalSplit,
    estimateFee,
    inputVbytes,
    isOctojoinLabel,
    isRound,
    outputVbytes,
    planOctojoin,
    selectInputs,
    smallestSplittable,
    splitAmount,
    splitRange,
} from '../octojoin.js';

const P2WPKH = '0014' + '11'.repeat(20);
const P2WPKH2 = '0014' + '22'.repeat(20);
const P2WPKH3 = '0014' + '33'.repeat(20);
const P2TR = '5120' + '33'.repeat(32);
const P2PKH = '76a914' + '44'.repeat(20) + '88ac';

const DUST = dustThreshold(P2WPKH);
const FEE_WITH_CHANGE = estimateFee({ inputScripts: [P2WPKH, P2WPKH, P2WPKH], outputScripts: [P2WPKH, P2WPKH2, P2WPKH], feeRate: 1 });

let nextVout = 0;
function coin(valueSats, isSwapped, spk = P2WPKH) {
    return { txid: '00'.repeat(32), vout: nextVout++, valueSats, isSwapped, spk, label: isSwapped ? 'octojoin' : '' };
}

function outputs(count) {
    return [
        { address: 'bc1qpay1', spk: P2WPKH },
        { address: 'bc1qpay2', spk: P2WPKH2 },
        { address: 'bc1qpay3', spk: P2WPKH3 },
    ].slice(0, count);
}

function plan(utxos, paymentSats, { numOutputs = 2, numInputs = 3, feeRate = 1, seed = 'octojoin', equalOutputs = false } = {}) {
    return planOctojoin({
        utxos,
        paymentSats,
        outputs: outputs(numOutputs),
        numInputs,
        numOutputs,
        feeRate,
        changeSpk: P2WPKH,
        rng: new Randomness(Buffer.from(seed)),
        equalOutputs,
    });
}

const values = p => p.paymentTargets.map(t => t.valueSats);

test('script sizes match the consensus serialization', () => {
    assert.equal(outputVbytes(P2WPKH), 31);
    assert.equal(outputVbytes(P2TR), 43);
    assert.equal(outputVbytes(P2PKH), 34);
    assert.equal(inputVbytes(P2WPKH), 68);
    assert.equal(inputVbytes(P2TR), 58);
    assert.equal(inputVbytes(P2PKH), 148);
});

test('dust thresholds follow the script type, not a fixed 546', () => {
    assert.equal(dustThreshold(P2WPKH), 294);
    assert.equal(dustThreshold(P2TR), 330);
    assert.equal(dustThreshold(P2PKH), 546);
});

test('estimateFee rounds up', () => {
    const fee = estimateFee({ inputScripts: [P2WPKH, P2WPKH, P2WPKH], outputScripts: [P2WPKH, P2WPKH], feeRate: 1.5 });
    assert.equal(fee, Math.ceil((11 + 3 * 68 + 2 * 31) * 1.5));
});

test('isOctojoinLabel matches case insensitively and inside longer labels', () => {
    assert.ok(isOctojoinLabel('octojoin'));
    assert.ok(isOctojoinLabel('Swapped OctoJoin coin'));
    assert.ok(!isOctojoinLabel('savings'));
    assert.ok(!isOctojoinLabel(null));
});

test('Randomness repeats for a seed and stays in range', () => {
    const draw = seed => {
        const rng = new Randomness(Buffer.from(seed));
        return Array.from({ length: 200 }, () => rng.below(1000));
    };
    assert.deepEqual(draw('seed'), draw('seed'));
    assert.notDeepEqual(draw('seed'), draw('other'));
    assert.ok(draw('seed').every(d => d >= 0 && d < 1000));
    const small = new Randomness(Buffer.from('x'));
    assert.deepEqual(new Set(Array.from({ length: 100 }, () => small.below(3))), new Set([0, 1, 2]));
});

test('the split range is half to one and a half shares above dust', () => {
    assert.deepEqual(splitRange(300000, 2, DUST), [75000, 225000]);
    assert.deepEqual(splitRange(300000, 3, DUST), [50000, 150000]);
    assert.deepEqual(splitRange(1200, 2, 546), [547, 900]);
    assert.equal(smallestSplittable(2, 546), 547 + 548);
});

test('a split adds up and has different values that are not round', () => {
    for (const k of [2, 3, 4, 5]) {
        for (const paymentSats of [5000, 80000, 200000, 300000, 1000000, 123456789]) {
            const rng = new Randomness(Buffer.from(`${paymentSats}/${k}`));
            const [lo, hi] = splitRange(paymentSats, k, 546);
            for (let i = 0; i < 20; i++) {
                const parts = splitAmount(paymentSats, k, 546, rng);
                assert.equal(parts.length, k);
                assert.equal(parts.reduce((a, b) => a + b, 0), paymentSats);
                assert.ok(parts.every(v => v >= lo && v <= hi));
                assert.equal(new Set(parts).size, k);
                assert.ok(!parts.some(isRound));
            }
        }
    }
});

test('a split avoids the change value and can put a value below a bound', () => {
    const rng = new Randomness(Buffer.from('bound'));
    for (let i = 0; i < 50; i++) {
        const parts = splitAmount(400000, 2, DUST, rng, { changeSats: 150001, below: 120000 });
        assert.ok(!parts.includes(150001) && Math.min(...parts) < 120000);
    }
});

test('selectInputs uses exactly one sender coin and numInputs - 1 swapped coins', () => {
    const best = selectInputs({
        swapped: [coin(200000, true), coin(300000, true), coin(400000, true)],
        other: [coin(500000, false), coin(900000, false)],
        numInputs: 3,
        paymentSats: 600000,
        paymentScripts: [P2WPKH, P2WPKH2],
        changeSpk: P2WPKH,
        feeRate: 1,
        changeDust: DUST,
        split: splitRange(600000, 2, DUST),
        rng: new Randomness(Buffer.from('s')),
    });
    assert.equal(best.inputs.length, 3);
    assert.equal(best.inputs.filter(u => u.isSwapped).length, 2);
    assert.equal(best.total, 600000 + best.changeSats + best.feeSats);
});

test('planOctojoin prefers a selection without an unnecessary input', () => {
    const utxos = [coin(100000, true), coin(100000, true), coin(900000, true), coin(100000, false), coin(1000000, false)];
    for (let seed = 0; seed < 20; seed++) {
        const p = plan(utxos, 290000, { seed: `s${seed}` });
        assert.ok(p.uihClean);
        assert.ok(p.changeSats < Math.min(...p.inputs.map(u => u.valueSats)));
    }
});

test('planOctojoin prefers change that looks like a payment output', () => {
    const utxos = [coin(120000, true), coin(130000, true), coin(100000, false), coin(140000, false)];
    for (let seed = 0; seed < 20; seed++) {
        const p = plan(utxos, 300000, { seed: `s${seed}` });
        assert.equal(p.inputs[2].valueSats, 140000);
        assert.ok(p.uihClean && p.changeHidden);
        assert.deepEqual(p.warnings, []);
    }
});

test('planOctojoin prefers a selection without change', () => {
    // the 50,400 coin leaves 92 sat after the fee, which goes to the fee instead of a change output
    const utxos = [coin(120000, true), coin(130000, true), coin(140000, false), coin(50400, false)];
    for (let seed = 0; seed < 20; seed++) {
        const p = plan(utxos, 300000, { seed: `s${seed}` });
        assert.equal(p.changeSats, 0);
        assert.equal(p.feeSats, 400);
        assert.equal(p.inputs[2].valueSats, 50400);
        assert.deepEqual(p.warnings, []);
    }
});

test('equal outputs split the amount evenly', () => {
    assert.deepEqual(equalSplit(300000, 2), [150000, 150000]);
    assert.deepEqual(equalSplit(300001, 2), [150001, 150000]);
    assert.deepEqual(equalSplit(100000, 3), [33334, 33333, 33333]);
    assert.equal(smallestSplittable(2, 546, true), 2 * 547);
});

test('equal outputs prefer a selection without change and warn otherwise', () => {
    const swapped = [coin(120000, true), coin(130000, true)];
    const p = plan([...swapped, coin(140000, false), coin(50400, false)], 300000, { equalOutputs: true });
    assert.deepEqual(values(p), [150000, 150000]);
    assert.equal(p.changeSats, 0);
    assert.deepEqual(p.warnings, []);
    const withChange = plan([...swapped, coin(140000, false)], 300000, { equalOutputs: true });
    assert.deepEqual(values(withChange), [150000, 150000]);
    assert.equal(withChange.changeSats, 89692);
    assert.deepEqual(withChange.warnings, [CHANGE_BESIDE_EQUAL_OUTPUTS]);
});

test('equal outputs only need every output above dust', () => {
    const utxos = [coin(300000, true), coin(300000, true), coin(300000, false)];
    assert.throws(() => plan(utxos, 2 * (DUST + 1) - 1, { equalOutputs: true }), { code: 'outputBelowDust' });
    assert.deepEqual(values(plan(utxos, 2 * (DUST + 1), { equalOutputs: true })), [DUST + 1, DUST + 1]);
});

test('change below every input has a payment output below every input too', () => {
    const utxos = [coin(120000, true), coin(130000, true), coin(140000, false)];
    const ranks = new Set();
    for (let seed = 0; seed < 100; seed++) {
        const p = plan(utxos, 300000, { seed: `s${seed}` });
        const smallestInput = Math.min(...p.inputs.map(u => u.valueSats));
        assert.ok(p.changeSats < smallestInput);
        assert.ok(Math.min(...values(p)) < smallestInput, 'the change is not the only output below every input');
        ranks.add([...values(p), p.changeSats].sort((a, b) => a - b).indexOf(p.changeSats));
    }
    assert.deepEqual(ranks, new Set([0, 1]), 'the change is not always in the same place');
});

test('round change moves 1 sat to the fee', () => {
    const p = plan([coin(120000, true), coin(130000, true), coin(140000 + FEE_WITH_CHANGE, false)], 300000);
    assert.equal(p.changeSats, 89999);
    assert.equal(p.feeSats, FEE_WITH_CHANGE + 1);
});

test('planOctojoin drops a dust change output into the fee', () => {
    const total = 800000 + FEE_WITH_CHANGE + 100;
    const p = plan([coin(300000, true), coin(300000, true), coin(total - 600000, false)], 800000);
    assert.equal(p.changeSats, 0);
    assert.equal(p.feeSats, total - 800000);
    assert.ok(p.uihClean && p.changeHidden);
});

test('planOctojoin honors numOutputs and conserves the payment', () => {
    const p = plan([coin(400000, true), coin(400000, true), coin(600000, false)], 800000, { numOutputs: 3 });
    assert.equal(p.paymentTargets.length, 3);
    assert.equal(values(p).reduce((a, b) => a + b, 0), 800000);
    assert.equal(p.totalInputSats, 800000 + p.changeSats + p.feeSats);
});

test('planOctojoin warns about what an observer could notice', () => {
    const large = plan([coin(500000, true), coin(500000, true), coin(500000, false)], 300000);
    assert.ok(!large.uihClean && large.warnings.includes(UNNECESSARY_INPUT));
    const small = plan([coin(100000, true), coin(100000, true), coin(110000, false)], 300000);
    assert.deepEqual(small.warnings, [CHANGE_IDENTIFIABLE]);
});

test('planOctojoin rejects amounts it cannot split and shapes it cannot build', () => {
    const utxos = [coin(300000, true), coin(300000, true), coin(300000, false)];
    assert.throws(() => plan(utxos, 200), { code: 'amountBelowDust' });
    assert.throws(() => plan(utxos, 2 * (DUST + 1)), { code: 'outputBelowDust' });
    assert.deepEqual(values(plan(utxos, 2 * (DUST + 1) + 1)).sort((a, b) => a - b), [DUST + 1, DUST + 2]);
    assert.throws(() => plan([coin(300000, true), coin(300000, false)], 300000), { code: 'notEnoughSwappedCoins' });
    assert.throws(() => plan([coin(300000, true), coin(300000, true), coin(300000, true)], 300000), { code: 'noSenderCoin' });
    assert.throws(
        () => plan([coin(300000, true), coin(300000, true), coin(200001, false)], 800000, { feeRate: 10 }),
        { code: 'insufficientFunds' },
    );
    assert.throws(
        () => planOctojoin({
            utxos, paymentSats: 300000, outputs: outputs(3), numInputs: 3, numOutputs: 2, feeRate: 1, changeSpk: P2WPKH,
        }),
        { code: 'outputsMismatch' },
    );
});

// The same vectors run against the planner of the Electrum plugin, so both
// implementations make the same choices from the same random stream.
test('plans match the shared test vectors', () => {
    const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url)));
    for (const v of vectors) {
        const utxos = v.coins.map((c, i) => ({ ...c, txid: '00'.repeat(32), vout: i }));
        let result;
        try {
            const p = planOctojoin({
                utxos,
                paymentSats: v.paymentSats,
                outputs: v.outputs.map((spk, i) => ({ address: `recipient${i}`, spk })),
                numInputs: v.numInputs,
                numOutputs: v.numOutputs,
                feeRate: v.feeRate,
                changeSpk: v.changeSpk,
                rng: new Randomness(Buffer.from(v.seed, 'hex')),
                equalOutputs: v.equalOutputs,
            });
            result = {
                inputs: p.inputs.map(u => u.vout),
                payments: values(p),
                changeSats: p.changeSats,
                feeSats: p.feeSats,
                uihClean: p.uihClean,
                changeHidden: p.changeHidden,
            };
        } catch (e) {
            result = { error: e.code };
        }
        assert.deepEqual(result, v.expected, v.name);
    }
});

test('random plans conserve value and never round or repeat an output', () => {
    const rng = new Randomness(Buffer.from('random plans'));
    const between = (lo, hi) => lo + rng.below(hi - lo);
    for (let i = 0; i < 300; i++) {
        const utxos = [];
        const numSwapped = between(2, 8);
        for (let j = 0; j < numSwapped; j++) utxos.push(coin(between(20000, 3000000), true));
        const numOwn = between(1, 5);
        for (let j = 0; j < numOwn; j++) utxos.push(coin(between(20000, 3000000), false));
        const paymentSats = between(1000, 4000000);
        const numOutputs = between(2, 4);
        let p;
        try {
            p = plan(utxos, paymentSats, { numOutputs, feeRate: [1, 2.5, 7][between(0, 3)], seed: `r${i}` });
        } catch (e) {
            assert.ok(['insufficientFunds', 'outputBelowDust'].includes(e.code), e.code);
            continue;
        }
        const outs = [...values(p), ...(p.changeSats ? [p.changeSats] : [])];
        assert.equal(values(p).reduce((a, b) => a + b, 0), paymentSats);
        assert.equal(p.totalInputSats, paymentSats + p.changeSats + p.feeSats);
        assert.equal(p.inputs.filter(u => u.isSwapped).length, 2);
        assert.ok(p.changeSats === 0 || p.changeSats > DUST);
        assert.equal(new Set(outs).size, outs.length);
        assert.ok(!outs.some(isRound));
    }
});
