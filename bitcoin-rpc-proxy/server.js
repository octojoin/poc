import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, '..', 'octojoin')));

const STANDARD_DENOMINATIONS = [1.0, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];
const DUST_THRESHOLD = 0.00000546;
const VBYTES_PER_INPUT = 68;
const VBYTES_PER_OUTPUT = 31;
const TX_OVERHEAD = 11;

app.use(cors());
app.use(express.json());

function getWalletNameFromUrl(rpcUrl) {
    const urlParts = rpcUrl.split('/');
    return urlParts[urlParts.length - 1];
}

async function rpcCall(rpcUrl, rpcUsername, rpcPassword, method, params = []) {
    const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(`${rpcUsername}:${rpcPassword}`).toString('base64')
        },
        body: JSON.stringify({
            jsonrpc: "1.0",
            id: "curltest",
            method,
            params
        })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.result;
}

function decomposeAmount(amount) {
    const denominations = [];
    let remaining = amount;

    for (const denom of STANDARD_DENOMINATIONS) {
        while (remaining >= denom - 0.00000001) {
            denominations.push(denom);
            remaining = Math.round((remaining - denom) * 100000000) / 100000000;
        }
    }

    if (remaining > DUST_THRESHOLD) {
        denominations.push(remaining);
    } else if (remaining > 0 && denominations.length > 0) {
        // fold a sub-dust remainder into the last output instead of losing it to fees
        const last = denominations.length - 1;
        denominations[last] = Math.round((denominations[last] + remaining) * 100000000) / 100000000;
    }

    return denominations;
}

function distributeOutputs(denominations, addresses) {
    const outputs = {};
    addresses.forEach(addr => outputs[addr] = 0);

    denominations.forEach((denom, index) => {
        const addrIndex = index % addresses.length;
        outputs[addresses[addrIndex]] = Math.round((outputs[addresses[addrIndex]] + denom) * 100000000) / 100000000;
    });

    return outputs;
}

function chooseCombinations(arr, k) {
    if (k === 0) return [[]];
    if (k > arr.length) return [];
    const result = [];
    for (let i = 0; i <= arr.length - k; i++) {
        for (const rest of chooseCombinations(arr.slice(i + 1), k - 1)) {
            result.push([arr[i], ...rest]);
        }
    }
    return result;
}

// Select (numInputs - 1) swapped decoys plus exactly one sender coin so that the
// change is smaller than the smallest input. Otherwise an input could be dropped
// while the payment is still funded - the unnecessary input heuristic - which
// fingerprints the transaction (https://eprint.iacr.org/2022/589.pdf). Prefer a
// clean selection, then the smallest change. Returns null when no funding
// selection exists. target is the payment amount plus the estimated fee, in BTC.
function selectUTXOs(swappedUTXOs, otherUTXOs, numInputs, target) {
    const numSwapped = numInputs - 1;
    if (swappedUTXOs.length < numSwapped || otherUTXOs.length < 1) return null;

    const swappedPool = [...swappedUTXOs].sort((a, b) => a.amount - b.amount).slice(0, numSwapped + 6);
    const senders = [...otherUTXOs].sort((a, b) => a.amount - b.amount).slice(0, 10);

    let best = null;
    for (const combo of chooseCombinations(swappedPool, numSwapped)) {
        const swappedValue = combo.reduce((sum, u) => sum + u.amount, 0);
        for (const sender of senders) {
            const total = Math.round((swappedValue + sender.amount) * 100000000) / 100000000;
            if (total < target) continue;
            const change = Math.round((total - target) * 100000000) / 100000000;
            const minInput = Math.min(sender.amount, ...combo.map(u => u.amount));
            const clean = change < minInput;
            if (!best || (clean && !best.clean) || (clean === best.clean && change < best.change)) {
                best = { swapped: combo, other: sender, total, change, clean };
            }
        }
    }
    return best;
}

function estimateTxSize(numInputs, numOutputs) {
    return TX_OVERHEAD + (numInputs * VBYTES_PER_INPUT) + (numOutputs * VBYTES_PER_OUTPUT);
}

function totalValue(utxos) {
    return utxos.reduce((sum, utxo) => sum + utxo.amount, 0);
}

app.post('/fetch-utxos', async (req, res) => {
    const { rpcUrl, rpcUsername, rpcPassword } = req.body;
    const walletName = getWalletNameFromUrl(rpcUrl);

    try {
        try {
            await rpcCall(rpcUrl, rpcUsername, rpcPassword, 'loadwallet', [walletName]);
            console.log(`Wallet ${walletName} loaded successfully.`);
        } catch (error) {
            if (!error.message.includes("already loaded")) {
                console.error(`Error loading wallet ${walletName}:`, error);
                return res.status(500).json({ error: `Error loading wallet ${walletName}` });
            }
            console.log(`Wallet ${walletName} already loaded.`);
        }

        const utxos = await rpcCall(rpcUrl, rpcUsername, rpcPassword, 'listunspent');
        res.json({ result: utxos });
    } catch (error) {
        console.error("Error fetching UTXOs:", error);
        res.status(500).json({ error: "Error fetching UTXOs" });
    }
});

app.post('/get-fee-rate', async (req, res) => {
    const { rpcUrl, rpcUsername, rpcPassword, confTarget = 6 } = req.body;

    try {
        const feeEstimate = await rpcCall(rpcUrl, rpcUsername, rpcPassword, 'estimatesmartfee', [confTarget]);

        if (feeEstimate.errors) {
            return res.json({ feeRate: 1.0, source: 'fallback' });
        }

        const feeRateSatPerVB = (feeEstimate.feerate * 100000000) / 1000;
        res.json({ feeRate: feeRateSatPerVB, source: 'estimated' });
    } catch (error) {
        console.error("Error getting fee rate:", error);
        res.json({ feeRate: 1.0, source: 'fallback' });
    }
});

app.post('/get-new-address', async (req, res) => {
    const { rpcUrl, rpcUsername, rpcPassword, label = '' } = req.body;

    try {
        const address = await rpcCall(rpcUrl, rpcUsername, rpcPassword, 'getnewaddress', [label, 'bech32']);
        res.json({ address });
    } catch (error) {
        console.error("Error getting new address:", error);
        res.status(500).json({ error: "Error getting new address" });
    }
});

app.post('/label-utxo', async (req, res) => {
    const { rpcUrl, rpcUsername, rpcPassword, address, label } = req.body;

    try {
        await rpcCall(rpcUrl, rpcUsername, rpcPassword, 'setlabel', [address, label]);
        res.json({ success: true, message: `Address ${address} labeled as '${label}'` });
    } catch (error) {
        console.error("Error labeling address:", error);
        res.status(500).json({ error: "Error labeling address" });
    }
});

app.post('/create-psbt', async (req, res) => {
    const {
        rpcUrl, rpcUsername, rpcPassword,
        paymentAmount, bitcoinAddresses,
        numInputs = 3, numOutputs = 2,
        feeRate = 1.0
    } = req.body;

    try {
        const utxos = await rpcCall(rpcUrl, rpcUsername, rpcPassword, 'listunspent');
        const swappedUTXOs = utxos.filter(utxo => utxo.label === 'octojoin');
        const otherUTXOs = utxos.filter(utxo => utxo.label !== 'octojoin');

        const requiredSwapped = numInputs - 1;
        if (swappedUTXOs.length < requiredSwapped) {
            return res.status(400).json({
                error: `Need at least ${requiredSwapped} swapped UTXOs (labeled 'octojoin'), found ${swappedUTXOs.length}`
            });
        }
        if (otherUTXOs.length < 1) {
            return res.status(400).json({ error: "Need at least 1 non-swapped UTXO" });
        }
        if (bitcoinAddresses.length < 2) {
            return res.status(400).json({ error: "Need at least 2 output addresses" });
        }

        const estimatedSize = estimateTxSize(numInputs, numOutputs + 1);
        const estimatedFee = (estimatedSize * feeRate) / 100000000;
        const target = Math.round((paymentAmount + estimatedFee) * 100000000) / 100000000;

        const selected = selectUTXOs(swappedUTXOs, otherUTXOs, numInputs, target);
        if (!selected) {
            return res.status(400).json({
                error: `Could not select inputs without an unnecessary input. Use smaller or different 'octojoin' coins so the change is smaller than every input, or add more funds.`
            });
        }

        const allSelectedUTXOs = [...selected.swapped, selected.other];
        const totalInputValue = selected.total;
        const changeAmount = selected.change;

        const denominations = decomposeAmount(paymentAmount);
        const paymentOutputs = distributeOutputs(denominations, bitcoinAddresses);

        const inputs = allSelectedUTXOs.map(utxo => ({
            txid: utxo.txid,
            vout: utxo.vout
        }));

        const outputs = { ...paymentOutputs };

        let changeAddress = null;
        if (changeAmount > DUST_THRESHOLD) {
            changeAddress = await rpcCall(rpcUrl, rpcUsername, rpcPassword, 'getnewaddress', ['change', 'bech32']);
            outputs[changeAddress] = changeAmount;
        }

        const psbt = await rpcCall(rpcUrl, rpcUsername, rpcPassword, 'createpsbt', [inputs, outputs]);

        res.json({
            psbt,
            details: {
                inputs: allSelectedUTXOs.map(u => ({
                    txid: u.txid,
                    vout: u.vout,
                    amount: u.amount,
                    label: u.label || 'unlabeled',
                    confirmations: u.confirmations
                })),
                paymentOutputs,
                denominations,
                changeAddress,
                changeAmount: changeAmount > DUST_THRESHOLD ? changeAmount : 0,
                estimatedFee,
                feeRate,
                totalInputValue,
                totalOutputValue: paymentAmount + (changeAmount > DUST_THRESHOLD ? changeAmount : 0)
            }
        });
    } catch (error) {
        console.error("Error creating PSBT:", error);
        res.status(500).json({ error: error.message || "Error creating PSBT" });
    }
});

app.post('/sign-psbt', async (req, res) => {
    const { rpcUrl, rpcUsername, rpcPassword, psbt } = req.body;

    try {
        const result = await rpcCall(rpcUrl, rpcUsername, rpcPassword, 'walletprocesspsbt', [psbt]);
        res.json({
            psbt: result.psbt,
            complete: result.complete
        });
    } catch (error) {
        console.error("Error signing PSBT:", error);
        res.status(500).json({ error: error.message || "Error signing PSBT" });
    }
});

app.post('/broadcast-tx', async (req, res) => {
    const { rpcUrl, rpcUsername, rpcPassword, psbt } = req.body;

    try {
        const finalized = await rpcCall(rpcUrl, rpcUsername, rpcPassword, 'finalizepsbt', [psbt]);

        if (!finalized.complete) {
            return res.status(400).json({ error: "PSBT is not complete and cannot be finalized" });
        }

        const txid = await rpcCall(rpcUrl, rpcUsername, rpcPassword, 'sendrawtransaction', [finalized.hex]);

        res.json({
            txid,
            hex: finalized.hex
        });
    } catch (error) {
        console.error("Error broadcasting transaction:", error);
        res.status(500).json({ error: error.message || "Error broadcasting transaction" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
