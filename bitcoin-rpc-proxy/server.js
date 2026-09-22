import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
    MIN_INPUTS,
    MIN_OUTPUTS,
    OCTOJOIN_LABEL,
    OctojoinError,
    isOctojoinLabel,
    planOctojoin,
    scriptType,
} from './octojoin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.OCTOJOIN_DATA_DIR || path.join(__dirname, 'data');
const MANAGED = process.env.OCTOJOIN_MANAGED === '1';
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DRAFT_FILE = path.join(DATA_DIR, 'draft.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function envSettings() {
    const url =
        process.env.BITCOIN_RPC_URL ||
        (process.env.BITCOIN_RPC_HOST
            ? `http://${process.env.BITCOIN_RPC_HOST}:${process.env.BITCOIN_RPC_PORT || 8332}`
            : '');
    return {
        rpcUrl: url,
        rpcUser: process.env.BITCOIN_RPC_USER || '',
        rpcPassword: process.env.BITCOIN_RPC_PASS || '',
        wallet: process.env.OCTOJOIN_WALLET || 'octojoin',
    };
}

function readStoredSettings() {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
        return null;
    }
}

// Credentials stay on the server. The browser never receives or stores them.
function settings() {
    const env = envSettings();
    if (MANAGED) return env;
    const stored = readStoredSettings();
    if (!stored) return env;
    return {
        rpcUrl: stored.rpcUrl || env.rpcUrl,
        rpcUser: stored.rpcUser || env.rpcUser,
        rpcPassword: stored.rpcPassword || env.rpcPassword,
        wallet: stored.wallet || env.wallet,
    };
}

function writeSettings(next) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
}

function readDraft() {
    try {
        return JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function writeDraft(draft) {
    fs.writeFileSync(DRAFT_FILE, JSON.stringify(draft, null, 2), { mode: 0o600 });
}

function clearDraft() {
    try {
        fs.unlinkSync(DRAFT_FILE);
    } catch {
        // no draft to clear
    }
}

function satsToBtc(sats) {
    return (sats / 100000000).toFixed(8);
}

function btcToSats(btc) {
    return Math.round(btc * 100000000);
}

function shuffle(items) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

async function rpcCall(method, params = [], { wallet = true } = {}) {
    const { rpcUrl, rpcUser, rpcPassword, wallet: walletName } = settings();
    if (!rpcUrl) throw new Error('Bitcoin RPC is not configured');

    const base = rpcUrl.replace(/\/+$/, '');
    const url = wallet ? `${base}/wallet/${encodeURIComponent(walletName)}` : base;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${rpcUser}:${rpcPassword}`).toString('base64'),
        },
        body: JSON.stringify({ jsonrpc: '1.0', id: 'octojoin', method, params }),
    });

    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`Bitcoin RPC returned ${response.status}: ${text.slice(0, 200)}`);
    }
    if (data.error) throw new Error(data.error.message);
    return data.result;
}

async function ensureWalletLoaded() {
    const { wallet } = settings();
    const loaded = await rpcCall('listwallets', [], { wallet: false });
    if (loaded.includes(wallet)) return wallet;
    try {
        await rpcCall('loadwallet', [wallet], { wallet: false });
    } catch (error) {
        if (!error.message.includes('already loaded')) throw error;
    }
    return wallet;
}

async function spendableUTXOs() {
    await ensureWalletLoaded();
    const [utxos, locked] = await Promise.all([rpcCall('listunspent'), rpcCall('listlockunspent')]);
    const lockedKeys = new Set(locked.map(l => `${l.txid}:${l.vout}`));

    return utxos
        .filter(u => !lockedKeys.has(`${u.txid}:${u.vout}`))
        .filter(u => u.solvable !== false)
        .map(u => ({
            txid: u.txid,
            vout: u.vout,
            address: u.address,
            spk: u.scriptPubKey,
            valueSats: btcToSats(u.amount),
            label: u.label || '',
            confirmations: u.confirmations,
            isSwapped: isOctojoinLabel(u.label),
        }));
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'octojoin')));

app.get('/status', async (req, res) => {
    const { rpcUrl, wallet } = settings();
    const status = {
        managed: MANAGED,
        configured: Boolean(rpcUrl),
        wallet,
        node: null,
        walletInfo: null,
        coins: null,
        draft: Boolean(readDraft()),
        error: null,
    };

    if (!status.configured) return res.json(status);

    try {
        const chainInfo = await rpcCall('getblockchaininfo', [], { wallet: false });
        status.node = {
            chain: chainInfo.chain,
            blocks: chainInfo.blocks,
            initialBlockDownload: chainInfo.initialblockdownload,
        };

        await ensureWalletLoaded();
        const walletInfo = await rpcCall('getwalletinfo');
        status.walletInfo = {
            name: walletInfo.walletname,
            canSign: walletInfo.private_keys_enabled !== false,
            descriptors: walletInfo.descriptors === true,
        };

        const utxos = await spendableUTXOs();
        status.coins = {
            swapped: utxos.filter(u => u.isSwapped).length,
            other: utxos.filter(u => !u.isSwapped).length,
            swappedSats: utxos.filter(u => u.isSwapped).reduce((sum, u) => sum + u.valueSats, 0),
            otherSats: utxos.filter(u => !u.isSwapped).reduce((sum, u) => sum + u.valueSats, 0),
        };
    } catch (error) {
        status.error = error.message;
    }

    res.json(status);
});

app.get('/settings', (req, res) => {
    const { rpcUrl, rpcUser, rpcPassword, wallet } = settings();
    res.json({ managed: MANAGED, rpcUrl, rpcUser, wallet, hasPassword: Boolean(rpcPassword) });
});

app.post('/settings', (req, res) => {
    if (MANAGED) {
        return res.status(403).json({ error: 'RPC settings are managed by the host and cannot be changed here' });
    }
    const current = settings();
    const { rpcUrl, rpcUser, rpcPassword, wallet } = req.body;
    writeSettings({
        rpcUrl: rpcUrl || current.rpcUrl,
        rpcUser: rpcUser || current.rpcUser,
        rpcPassword: rpcPassword || current.rpcPassword,
        wallet: wallet || current.wallet,
    });
    res.json({ success: true });
});

app.get('/utxos', async (req, res) => {
    try {
        const utxos = await spendableUTXOs();
        res.json({
            swapped: utxos.filter(u => u.isSwapped),
            other: utxos.filter(u => !u.isSwapped),
        });
    } catch (error) {
        console.error('Error fetching UTXOs:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/fee-rate', async (req, res) => {
    const confTarget = parseInt(req.query.confTarget || '6', 10);
    try {
        const estimate = await rpcCall('estimatesmartfee', [confTarget], { wallet: false });
        if (!estimate || estimate.errors || !estimate.feerate) {
            return res.json({ feeRate: 1.0, source: 'fallback' });
        }
        res.json({ feeRate: (estimate.feerate * 100000000) / 1000, source: 'estimated' });
    } catch (error) {
        console.error('Error getting fee rate:', error);
        res.json({ feeRate: 1.0, source: 'fallback' });
    }
});

app.post('/label-utxo', async (req, res) => {
    const { address, label = OCTOJOIN_LABEL } = req.body;
    try {
        await ensureWalletLoaded();
        await rpcCall('setlabel', [address, label]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error labeling address:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/draft', (req, res) => {
    const draft = readDraft();
    if (!draft) return res.status(404).json({ error: 'No saved draft' });
    res.json(draft);
});

app.delete('/draft', (req, res) => {
    clearDraft();
    res.json({ success: true });
});

app.post('/create-psbt', async (req, res) => {
    const {
        paymentSats: paymentSatsRaw,
        paymentAmount,
        bitcoinAddresses = [],
        numInputs = MIN_INPUTS,
        numOutputs = MIN_OUTPUTS,
        feeRate = 1.0,
    } = req.body;

    try {
        const paymentSats =
            paymentSatsRaw !== undefined ? Math.round(paymentSatsRaw) : btcToSats(paymentAmount);
        if (!Number.isFinite(paymentSats) || paymentSats <= 0) {
            return res.status(400).json({ error: 'Enter a valid payment amount' });
        }
        if (!Number.isFinite(feeRate) || feeRate <= 0) {
            return res.status(400).json({ error: 'Enter a valid fee rate' });
        }

        await ensureWalletLoaded();

        const outputs = [];
        for (const address of bitcoinAddresses) {
            const info = await rpcCall('validateaddress', [address], { wallet: false });
            if (!info.isvalid) {
                return res.status(400).json({ error: `${address} is not a valid address on this network` });
            }
            outputs.push({ address, spk: info.scriptPubKey });
        }

        const types = new Set(outputs.map(o => scriptType(o.spk)));
        if (types.size > 1) {
            return res.status(400).json({
                error: 'All outputs must use the same script type. Mixed output types fingerprint the transaction.',
            });
        }
        const addressType = outputs.length ? scriptType(outputs[0].spk) : 'bech32';
        if (addressType === 'other') {
            return res.status(400).json({ error: 'Unsupported output script type' });
        }

        const changeAddress = await rpcCall('getnewaddress', ['octojoin change', addressType]);
        const changeInfo = await rpcCall('validateaddress', [changeAddress], { wallet: false });

        const utxos = await spendableUTXOs();
        if (utxos.length === 0) {
            return res.status(400).json({ error: 'The wallet has no spendable coins' });
        }

        const plan = planOctojoin({
            utxos,
            paymentSats,
            outputs,
            numInputs,
            numOutputs,
            feeRate,
            changeSpk: changeInfo.scriptPubKey,
        });

        const rpcInputs = shuffle(plan.inputs).map(u => ({ txid: u.txid, vout: u.vout }));
        const rpcOutputs = shuffle([
            ...plan.paymentTargets.map(t => ({ [t.address]: satsToBtc(t.valueSats) })),
            ...(plan.changeSats > 0 ? [{ [changeAddress]: satsToBtc(plan.changeSats) }] : []),
        ]);

        // anti fee sniping: ordinary wallets set the locktime to the current height
        const height = (await rpcCall('getblockchaininfo', [], { wallet: false })).blocks;
        const psbt = await rpcCall('createpsbt', [rpcInputs, rpcOutputs, height, true]);

        const details = {
            inputs: plan.inputs.map(u => ({
                txid: u.txid,
                vout: u.vout,
                valueSats: u.valueSats,
                label: u.label || 'unlabeled',
                confirmations: u.confirmations,
                isSwapped: u.isSwapped,
            })),
            paymentOutputs: plan.paymentTargets.map(t => ({ address: t.address, valueSats: t.valueSats })),
            denominations: plan.denominations,
            changeAddress: plan.changeSats > 0 ? changeAddress : null,
            changeSats: plan.changeSats,
            feeSats: plan.feeSats,
            feeRate,
            totalInputSats: plan.totalInputSats,
            paymentSats,
            uihClean: plan.uihClean,
            locktime: height,
        };

        writeDraft({ psbt, details, createdAt: new Date().toISOString() });
        res.json({ psbt, details });
    } catch (error) {
        if (error instanceof OctojoinError) {
            return res.status(400).json({ error: error.message, code: error.code });
        }
        console.error('Error creating PSBT:', error);
        res.status(500).json({ error: error.message || 'Error creating PSBT' });
    }
});

app.post('/sign-psbt', async (req, res) => {
    const { psbt } = req.body;
    try {
        await ensureWalletLoaded();
        const result = await rpcCall('walletprocesspsbt', [psbt]);
        const draft = readDraft();
        if (draft) writeDraft({ ...draft, signedPsbt: result.psbt });
        res.json({ psbt: result.psbt, complete: result.complete });
    } catch (error) {
        console.error('Error signing PSBT:', error);
        res.status(500).json({ error: error.message || 'Error signing PSBT' });
    }
});

app.post('/broadcast-tx', async (req, res) => {
    const { psbt } = req.body;
    try {
        await ensureWalletLoaded();
        let finalized = await rpcCall('finalizepsbt', [psbt]);

        // a PSBT signed by an external signer may hold only part of the signatures
        if (!finalized.complete) {
            const draft = readDraft();
            if (draft && draft.psbt && draft.psbt !== psbt) {
                const combined = await rpcCall('combinepsbt', [[draft.psbt, psbt]]);
                finalized = await rpcCall('finalizepsbt', [combined]);
            }
        }
        if (!finalized.complete) {
            return res.status(400).json({ error: 'PSBT is not fully signed and cannot be finalized' });
        }

        const txid = await rpcCall('sendrawtransaction', [finalized.hex]);
        clearDraft();
        res.json({ txid, hex: finalized.hex });
    } catch (error) {
        console.error('Error broadcasting transaction:', error);
        res.status(500).json({ error: error.message || 'Error broadcasting transaction' });
    }
});

app.listen(PORT, HOST, () => {
    const { rpcUrl, wallet } = settings();
    console.log(`octojoin listening on http://${HOST}:${PORT}`);
    console.log(`rpc ${rpcUrl || '(not configured)'} wallet ${wallet} managed ${MANAGED}`);
});
