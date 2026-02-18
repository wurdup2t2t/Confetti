import express from "express";
import bodyParser from "body-parser";
import { nanoid } from "nanoid";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));

app.use(express.urlencoded({ extended: true }));
app.get("/webhooks/alchemy", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => {
  res.send(`
    <html>
      <body style="font-family: system-ui; max-width: 520px; margin: 40px auto;">
        <h1>Confetti Order</h1>
        <p>Fill shipping info, then you'll get payment instructions (19.99 USDC on Base).</p>
        <form method="POST" action="/order/form">
          <input name="name" placeholder="Full Name" required style="width:100%;padding:10px;margin:6px 0;" />
          <input name="email" placeholder="Email (optional)" style="width:100%;padding:10px;margin:6px 0;" />
          <input name="address1" placeholder="Address Line 1" required style="width:100%;padding:10px;margin:6px 0;" />
          <input name="address2" placeholder="Address Line 2" style="width:100%;padding:10px;margin:6px 0;" />
          <input name="city" placeholder="City" required style="width:100%;padding:10px;margin:6px 0;" />
          <input name="state" placeholder="State" required style="width:100%;padding:10px;margin:6px 0;" />
          <input name="zip" placeholder="ZIP" required style="width:100%;padding:10px;margin:6px 0;" />
          <input name="country" placeholder="Country" value="US" required style="width:100%;padding:10px;margin:6px 0;" />
          <textarea name="confetti_note" placeholder="Confetti note (optional)" style="width:100%;padding:10px;margin:6px 0;height:90px;"></textarea>
          <button type="submit" style="padding:12px 16px;margin-top:10px;">Create Order</button>
        </form>
      </body>
    </html>
  `);
});

app.post("/order/form", (req, res) => {
  const { name, email, address1, address2, city, state, zip, country, confetti_note } = req.body || {};
  if (!name || !address1 || !city || !state || !zip || !country) {
    return res.status(400).send("Missing required shipping fields.");
  }

  // Reuse your existing /order/create logic by calling it directly:
  // (If you prefer, you can copy the create-order block here.)
  const id = nanoid(10);
  const orders = loadOrders();
  orders[id] = {
    id,
    status: "AWAITING_PAYMENT",
    createdAt: new Date().toISOString(),
    price: PRICE,
    receiver: RECEIVER,
    shipping: { name, email, address1, address2, city, state, zip, country },
    confetti_note: confetti_note || "",
    payment: null,
  };
  saveOrders(orders);

  res.send(`
    <html>
      <body style="font-family: system-ui; max-width: 520px; margin: 40px auto;">
        <h2>Order Created ✅</h2>
        <p><b>Order ID:</b> ${id}</p>
        <p>Send exactly <b>${PRICE} USDC</b> on <b>Base</b> to:</p>
        <code style="display:block;padding:12px;background:#f4f4f4;border-radius:8px;">${RECEIVER}</code>
        <p>Once payment confirms, your order will process automatically.</p>
      </body>
    </html>
  `);
});


const PORT = Number(process.env.PORT || "8787");
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";

const RECEIVER = (process.env.RECEIVER || "").toLowerCase();
const USDC_CONTRACT_BASE = (process.env.USDC_CONTRACT_BASE || "").toLowerCase();
const PRICE = Number(process.env.PRICE || "19.99");

const DB_FILE = path.join(process.cwd(), "orders.json");
const loadOrders = () => (fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : {});
const saveOrders = (o) => fs.writeFileSync(DB_FILE, JSON.stringify(o, null, 2));

function runOpenClaw(message) {
  return new Promise((resolve, reject) => {
    execFile(OPENCLAW_BIN, ["agent", "--message", message], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

app.post("/order/create", (req, res) => {
  const { name, email, address1, address2, city, state, zip, country, confetti_note } = req.body || {};

  if (!name || !address1 || !city || !state || !zip || !country) {
    return res.status(400).json({ ok: false, error: "Missing required shipping fields." });
  }

  const id = nanoid(10);
  const orders = loadOrders();
  orders[id] = {
    id,
    status: "AWAITING_PAYMENT",
    createdAt: new Date().toISOString(),
    price: PRICE,
    receiver: RECEIVER,
    shipping: { name, email, address1, address2, city, state, zip, country },
    confetti_note: confetti_note || "",
    payment: null,
  };
  saveOrders(orders);

  res.json({
    ok: true,
    orderId: id,
    amountUSDC: PRICE,
    chain: "Base",
    payTo: RECEIVER,
    instructions: "Send exactly the amount in USDC on Base to the address above. Keep this Order ID for support.",
  });
});

function extractTransfers(payload) {
  return payload?.event?.activity || payload?.data?.activity || payload?.activity || [];
}
function asNumber(v) {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return NaN;
}

app.post("/webhooks/alchemy", async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const payload = req.body;
    const transfers = extractTransfers(payload);
    const orders = loadOrders();

    for (const t of transfers) {
      const to = (t.to || t.toAddress || t.receiver || "").toLowerCase();
      const from = (t.from || t.fromAddress || t.sender || "").toLowerCase();
      const token = (t.rawContract?.address || t.contractAddress || t.assetContractAddress || "").toLowerCase();
      const amount = asNumber(t.value ?? t.amount);
      const txHash = t.hash || t.transactionHash || t.txHash || "";

      if (!to || !token || !Number.isFinite(amount)) continue;
      if (to !== RECEIVER) continue;
      if (token !== USDC_CONTRACT_BASE) continue;
      if (amount + 1e-9 < PRICE) continue;

      const unpaid = Object.values(orders)
        .filter(o => o.status === "AWAITING_PAYMENT")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      if (!unpaid.length) continue;

      const order = unpaid[0];
      order.status = "PAID";
      order.payment = { amount, from, to, token, txHash, receivedAt: new Date().toISOString() };
      saveOrders(orders);

      const msg =
        `CONFETTI ORDER PAID ✅\n` +
        `Order: ${order.id}\n` +
        `Chain: Base\n` +
        `Amount: ${amount} USDC\n` +
        `Tx: ${txHash}\n\n` +
        `Ship To:\n` +
        `${order.shipping.name}\n` +
        `${order.shipping.address1}${order.shipping.address2 ? " " + order.shipping.address2 : ""}\n` +
        `${order.shipping.city}, ${order.shipping.state} ${order.shipping.zip}\n` +
        `${order.shipping.country}\n\n` +
        `Order notes: ${order.confetti_note || "(none)"}\n\n` +
        `Please: (1) create packing slip/checklist (2) draft customer confirmation message (3) mark Ready to Ship.`;

      await runOpenClaw(msg);
      console.log("✅ PAID + OpenClaw triggered:", order.id, txHash);
    }
  } catch (e) {
    console.error("webhook error:", e);
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
