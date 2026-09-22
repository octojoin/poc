import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bucketValues,
    decomposeAmount,
    dustThreshold,
    estimateFee,
    inputVbytes,
    isOctojoinLabel,
    outputVbytes,
    planOctojoin,
    selectUTXOs,
    splitToFill,
} from '../octojoin.js';

const P2WPKH = '0014' + '11'.repeat(20);
const P2WPKH2 = '0014' + '22'.repeat(20);
const P2TR = '5120' + '33'.repeat(32);
const P2PKH = '76a914' + '44'.repeat(20) + '88ac';

const DUST = dustThreshold(P2WPKH);

function coin(valueSats, isSwapped, spk = P2WPKH) {
    return { txid: '00'.repeat(32), vout: 0, valueSats, isSwapped, spk, label: isSwapped ? 'octojoin' : '' };
}

function outputs(count) {
    return [
        { address: 'bc1qpay1', spk: P2WPKH },
        { address: 'bc1qpay2', spk: P2WPKH2 },
        { address: 'bc1qpay3', spk: P2WPKH },
    ].slice(0, count);
}

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

test('decomposeAmount chunks into standard denominations', () => {
    assert.deepEqual(decomposeAmount(300000, DUST), [200000, 100000]);
    assert.deepEqual(decomposeAmount(800000, DUST), [500000, 200000, 100000]);
});

test('decomposeAmount keeps a non-dust remainder as its own output', () => {
    assert.deepEqual(decomposeAmount(150000, DUST), [100000, 50000]);
});

test('decomposeAmount folds a sub-dust remainder into the last output', () => {
    const denominations = decomposeAmount(100200, DUST);
    assert.deepEqual(denominations, [100200]);
    assert.equal(denominations.reduce((a, b) => a + b, 0), 100200);
});

test('decomposeAmount conserves value just under the dust threshold', () => {
    for (let amount = DUST - 5; amount <= DUST + 5; amount++) {
        const denominations = decomposeAmount(amount, DUST);
        const total = denominations.reduce((a, b) => a + b, 0);
        assert.equal(total === 0 || total === amount, true, `value lost at ${amount}`);
    }
});

test('decomposeAmount never silently drops value', () => {
    for (const amount of [100001, 123456, 999999, 1000001, 150000000]) {
        const total = decomposeAmount(amount, DUST).reduce((a, b) => a + b, 0);
        assert.equal(total, amount);
    }
});

test('bucketValues spreads denominations round robin into the requested outputs', () => {
    assert.deepEqual(bucketValues([100000, 200000, 500000], 2), [600000, 200000]);
    assert.deepEqual(bucketValues([100000, 200000, 500000], 3), [100000, 200000, 500000]);
});

test('isOctojoinLabel matches case insensitively and inside longer labels', () => {
    assert.equal(isOctojoinLabel('octojoin'), true);
    assert.equal(isOctojoinLabel('Swapped OctoJoin coin'), true);
    assert.equal(isOctojoinLabel('savings'), false);
    assert.equal(isOctojoinLabel(undefined), false);
});

test('selectUTXOs uses exactly one sender coin and numInputs - 1 swapped coins', () => {
    const swapped = [coin(200000, true), coin(300000, true), coin(400000, true)];
    const other = [coin(500000, false), coin(900000, false)];
    const best = selectUTXOs(swapped, other, 3, 600000);
    assert.equal(best.swapped.length, 2);
    assert.equal(best.other.isSwapped, false);
    assert.equal(best.total, best.swapped.reduce((s, u) => s + u.valueSats, 0) + best.other.valueSats);
});

test('selectUTXOs returns null when no single sender coin can cover the target', () => {
    const swapped = [coin(1000, true), coin(1000, true)];
    const other = [coin(1000, false)];
    assert.equal(selectUTXOs(swapped, other, 3, 10000000), null);
});

test('selectUTXOs prefers a clean selection over smaller change with an unnecessary input', () => {
    const swapped = [coin(100000, true), coin(100000, true), coin(900000, true)];
    const other = [coin(100000, false), coin(1000000, false)];
    const best = selectUTXOs(swapped, other, 3, 290000);
    assert.equal(best.clean, true);
    assert.equal(best.change < Math.min(best.other.valueSats, ...best.swapped.map(u => u.valueSats)), true);
});

test('planOctojoin conserves the payment across the outputs', () => {
    const plan = planOctojoin({
        utxos: [coin(400000, true), coin(400000, true), coin(500000, false)],
        paymentSats: 800000,
        outputs: outputs(2),
        numInputs: 3,
        numOutputs: 2,
        feeRate: 1,
        changeSpk: P2WPKH,
    });
    const paid = plan.paymentTargets.reduce((sum, t) => sum + t.valueSats, 0);
    assert.equal(paid, 800000);
    assert.equal(plan.totalInputSats, 800000 + plan.changeSats + plan.feeSats);
});

test('planOctojoin honors numOutputs', () => {
    const plan = planOctojoin({
        utxos: [coin(400000, true), coin(400000, true), coin(600000, false)],
        paymentSats: 800000,
        outputs: outputs(3),
        numInputs: 3,
        numOutputs: 3,
        feeRate: 1,
        changeSpk: P2WPKH,
    });
    assert.equal(plan.paymentTargets.length, 3);
    assert.equal(plan.paymentTargets.reduce((sum, t) => sum + t.valueSats, 0), 800000);
});

test('planOctojoin avoids the unnecessary input heuristic', () => {
    const plan = planOctojoin({
        utxos: [coin(300000, true), coin(300000, true), coin(400000, true), coin(300000, false), coin(5000000, false)],
        paymentSats: 800000,
        outputs: outputs(2),
        numInputs: 3,
        numOutputs: 2,
        feeRate: 2,
        changeSpk: P2WPKH,
    });
    assert.equal(plan.uihClean, true);
    const minInput = Math.min(...plan.inputs.map(u => u.valueSats));
    assert.equal(plan.changeSats === 0 || plan.changeSats < minInput, true);
});

test('planOctojoin drops a dust change output into the fee', () => {
    const feeWithChange = estimateFee({
        inputScripts: [P2WPKH, P2WPKH, P2WPKH],
        outputScripts: [P2WPKH, P2WPKH2, P2WPKH],
        feeRate: 1,
    });
    const total = 800000 + feeWithChange + 100;
    const plan = planOctojoin({
        utxos: [coin(300000, true), coin(300000, true), coin(total - 600000, false)],
        paymentSats: 800000,
        outputs: outputs(2),
        numInputs: 3,
        numOutputs: 2,
        feeRate: 1,
        changeSpk: P2WPKH,
    });
    assert.equal(plan.changeSats, 0);
    assert.equal(plan.feeSats, total - 800000);
});

test('planOctojoin rejects a payment at or below the dust threshold', () => {
    assert.throws(
        () =>
            planOctojoin({
                utxos: [coin(300000, true), coin(300000, true), coin(300000, false)],
                paymentSats: 200,
                outputs: outputs(2),
                numInputs: 3,
                numOutputs: 2,
                feeRate: 1,
                changeSpk: P2WPKH,
            }),
        /dust/,
    );
});

test('splitToFill splits standard denominations to reach the requested outputs', () => {
    assert.deepEqual(splitToFill([200000], 2, DUST), [100000, 100000]);
    const split = splitToFill([1000000], 3, DUST);
    assert.equal(split.length >= 3, true);
    assert.equal(split.reduce((a, b) => a + b, 0), 1000000);
    for (const numOutputs of [2, 3, 4]) {
        const filled = splitToFill(decomposeAmount(2000000, DUST), numOutputs, DUST);
        assert.equal(filled.length >= numOutputs, true);
        assert.equal(filled.reduce((a, b) => a + b, 0), 2000000);
    }
});

test('planOctojoin splits a single denomination across the requested outputs', () => {
    const plan = planOctojoin({
        utxos: [coin(300000, true), coin(300000, true), coin(300000, false)],
        paymentSats: 200000,
        outputs: outputs(2),
        numInputs: 3,
        numOutputs: 2,
        feeRate: 1,
        changeSpk: P2WPKH,
    });
    assert.deepEqual(plan.paymentTargets.map(t => t.valueSats), [100000, 100000]);
});

test('planOctojoin rejects an amount that cannot fill the requested outputs above dust', () => {
    assert.throws(
        () =>
            planOctojoin({
                utxos: [coin(300000, true), coin(300000, true), coin(300000, false)],
                paymentSats: 400,
                outputs: outputs(2),
                numInputs: 3,
                numOutputs: 2,
                feeRate: 1,
                changeSpk: P2WPKH,
            }),
        /dust/,
    );
});

test('planOctojoin rejects an address count that does not match numOutputs', () => {
    assert.throws(
        () =>
            planOctojoin({
                utxos: [coin(300000, true), coin(300000, true), coin(300000, false)],
                paymentSats: 300000,
                outputs: outputs(3),
                numInputs: 3,
                numOutputs: 2,
                feeRate: 1,
                changeSpk: P2WPKH,
            }),
        /exactly 2 output addresses/,
    );
});

test('planOctojoin requires enough swapped coins and one sender coin', () => {
    assert.throws(
        () =>
            planOctojoin({
                utxos: [coin(300000, true), coin(300000, false)],
                paymentSats: 300000,
                outputs: outputs(2),
                numInputs: 3,
                numOutputs: 2,
                feeRate: 1,
                changeSpk: P2WPKH,
            }),
        /swapped coins/,
    );

    assert.throws(
        () =>
            planOctojoin({
                utxos: [coin(300000, true), coin(300000, true), coin(300000, true)],
                paymentSats: 300000,
                outputs: outputs(2),
                numInputs: 3,
                numOutputs: 2,
                feeRate: 1,
                changeSpk: P2WPKH,
            }),
        /not labeled octojoin/,
    );
});

test('planOctojoin reports insufficient funds instead of underpaying the fee', () => {
    assert.throws(
        () =>
            planOctojoin({
                utxos: [coin(300000, true), coin(300000, true), coin(200001, false)],
                paymentSats: 800000,
                outputs: outputs(2),
                numInputs: 3,
                numOutputs: 2,
                feeRate: 10,
                changeSpk: P2WPKH,
            }),
        /fund|cover/,
    );
});
