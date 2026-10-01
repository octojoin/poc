### octojoin

Reference implementation of [Octojoin](https://github.com/octojoin/bip): a payment that spends
swapped coins alongside one of your own, splits the amount at random into values that are not
round across several outputs, and keeps the change from standing out.

It drives a Bitcoin Core wallet over RPC and serves a small web UI.

#### Run

```
cd bitcoin-rpc-proxy
npm install
BITCOIN_RPC_URL=http://127.0.0.1:8332 \
BITCOIN_RPC_USER=user \
BITCOIN_RPC_PASS=pass \
OCTOJOIN_WALLET=octojoin \
npm start
```

Open http://127.0.0.1:3000.

RPC settings can also be entered in the UI. They are stored server side in
`OCTOJOIN_DATA_DIR/settings.json`, never in the browser.

#### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `BITCOIN_RPC_URL` | none | Node RPC endpoint, without the wallet path |
| `BITCOIN_RPC_HOST` / `BITCOIN_RPC_PORT` | none / `8332` | Used when `BITCOIN_RPC_URL` is not set |
| `BITCOIN_RPC_USER` / `BITCOIN_RPC_PASS` | none | RPC credentials |
| `OCTOJOIN_WALLET` | `octojoin` | Core wallet to use |
| `OCTOJOIN_DATA_DIR` | `bitcoin-rpc-proxy/data` | Settings and saved PSBT drafts |
| `OCTOJOIN_MANAGED` | unset | `1` hides the settings UI and makes the environment authoritative |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Listen address |

#### Use

1. Get coins from an off-chain swap (statechain, coinswap or submarine swap) so their history is not
   yours, then label them `octojoin` under Coins.
2. Enter the payment amount, fee rate, number of inputs and outputs, and one fresh address per
   output.
3. Create the PSBT. Sign it with the node's wallet, or copy or download it, sign it in an external
   signer and paste the signed PSBT back to broadcast.

The preview warns when no choice of coins avoids an unnecessary input, or when the change cannot
be made to look like one of the payment outputs. Coins that leave no change are preferred. Coins of
a little less than half the amount each work best with the defaults of 3 inputs and 2 outputs.

Equal amounts in inputs spends coins whose values are within 10% of each other, looking at every
swapped coin, and the preview warns when no choice of coins has such inputs. Equal amounts in outputs
splits the payment into outputs of equal value instead of random ones. Equal outputs keep the change
hidden only when there is no change, so the preview warns when there is change.

A draft survives a restart, so the PSBT is still there after the server or container is restarted.

#### Test

```
cd bitcoin-rpc-proxy
npm test
```

#### Status

Outputs are plain addresses. BIP 352 silent payments, which the BIP recommends, are not implemented
here yet.
