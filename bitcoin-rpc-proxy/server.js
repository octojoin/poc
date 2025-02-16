import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';

const app = express();
const PORT = 3000;

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

app.post('/create-psbt', async (req, res) => {
    const { rpcUrl, rpcUsername, rpcPassword, paymentAmount, bitcoinAddresses, swappedUTXOs, otherUTXO } = req.body;

    // Error if less than 2 swapped UTXOs
    if (swappedUTXOs.length < 2) {
        return res.status(400).json({ error: "There should be at least 2 swapped UTXOs." });
    }

    // Error if no other UTXOs
    if (!otherUTXO) {
        return res.status(400).json({ error: "There should be at least 1 other UTXO." });
    }

    // Error if there are less than 2 output addresses
    if (bitcoinAddresses.length < 2) {
        return res.status(400).json({ error: "There should be at least 2 addresses for outputs." });
    }

    // Randomly divide the payment amount into two outputs (one large, one small)
    const largeAmount = Math.floor(paymentAmount * 0.7); 
    const smallAmount = paymentAmount - largeAmount; 
    // Prepare inputs for PSBT creation
    const inputs = [
        { txid: swappedUTXOs[0].txid, vout: swappedUTXOs[0].vout },
        { txid: swappedUTXOs[1].txid, vout: swappedUTXOs[1].vout },
        { txid: otherUTXO.txid, vout: otherUTXO.vout }
    ];

    // Prepare outputs with two addresses
    const outputs = {
        [bitcoinAddresses[0]]: largeAmount,
        [bitcoinAddresses[1]]: smallAmount  
    };

    try {
        const psbt = await rpcCall(rpcUrl, rpcUsername, rpcPassword, 'createpsbt', [inputs, outputs]);

        res.json({ psbt });
    } catch (error) {
        console.error("Error creating PSBT:", error);
        res.status(500).json({ error: "Error creating PSBT" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

