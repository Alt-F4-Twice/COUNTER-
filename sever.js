const express = require("express");
const axios = require("axios");
const cookieParser = require("cookie-parser");
const ADMIN_KEY = process.env.ADMIN_KEY;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cookieParser());

// In-memory storage (replace with DB for production)
let users = new Map();
let positionCounter = 1;

function isRankedUser(user) {
  return user.position != null && !user.admin && !user.test && user.ip !== "TEST" && user.ip !== "ADMIN";
}

function isSpecialUser(user) {
  return user.admin || user.test || user.ip === "TEST" || user.ip === "ADMIN";
}

function recalculatePositions() {
  const ranked = [...users.values()]
    .filter(isRankedUser)
    .sort((a, b) => a.position - b.position);

  ranked.forEach((user, index) => {
    user.position = index + 1;
  });

  positionCounter = ranked.length + 1;
}

// Generate 16-character ID
function generateId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// Generate 20-character Key
function generateKey(length = 20) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let key = "";
  for (let i = 0; i < length; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

function getUniqueId() {
  let id;
  do {
    id = generateId();
  } while ([...users.values()].some((u) => u.id === id));
  return id;
}

function getIP(req) {
  let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  if (!ip) return null;

  if (ip.includes(",")) {
    ip = ip.split(",")[0].trim();
  }

  if (ip === "::1") return "127.0.0.1";

  if (ip.startsWith("::ffff:")) {
    ip = ip.replace("::ffff:", "");
  }

  return ip;
}

async function checkIP(ip) {
  try {
    const res = await axios.get(
      `http://ip-api.com/json/${ip}?fields=proxy,hosting,org`
    );

    const data = res.data;
    let risk = 0;

    if (data.proxy === true) risk += 40;
    if (data.hosting === true) risk += 30;

    if (data.org) {
      const org = data.org.toLowerCase();

      if (
        org.includes("amazon") ||
        org.includes("google") ||
        org.includes("microsoft") ||
        org.includes("digitalocean") ||
        org.includes("linode") ||
        org.includes("ovh")
      ) {
        risk += 30;
      }
    }

    return { risk, data };
  } catch {
    return { risk: 0, data: {} };
  }
}

setInterval(() => {
  const now = Date.now();
  let deleted = false;

  for (const [id, user] of users) {
    if (
      !user.registered &&
      now - new Date(user.joined).getTime() > 180000
    ) {
      users.delete(id);
      deleted = true;
      console.log(`Deleted expired user: ${id}`);
    }
  }

  if (deleted) {
    recalculatePositions();
  }
}, 10000);

function getName(req) {
  const userAgent = req.headers["user-agent"] || "";

  if (userAgent.includes("Shortcuts")) {
    return "ShortcutUser";
  }

  if (req.query.name) {
    return req.query.name;
  }

  return "User";
}

function requireAdminKey(req, res) {
  if (req.query.key !== ADMIN_KEY) {
    res.status(403).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// COUNTER ROUTE — ranked users with positions
app.get("/counter", async (req, res) => {
  const ip = getIP(req);
  if (!ip) return res.status(400).json({ error: "Could not determine IP" });

  let userToken = req.cookies?.userToken;
  if (userToken && users.has(userToken)) {
    const existingUser = users.get(userToken);
    res.cookie("userToken", existingUser.id);
    res.setHeader("Content-Type", "application/json");
    return res.send(JSON.stringify(existingUser, null, 2));
  }

  const { risk } = await checkIP(ip);
  if (risk >= 50) return res.status(403).json({ error: "VPN/Proxy detected" });

  const existingUser = [...users.values()]
    .filter((u) => u.ip === ip && isRankedUser(u))
    .sort((a, b) => new Date(a.joined) - new Date(b.joined))[0];

  if (existingUser) {
    res.cookie("userToken", existingUser.id);
    res.setHeader("Content-Type", "application/json");
    return res.send(JSON.stringify(existingUser, null, 2));
  }

  const id = getUniqueId();
  const position = positionCounter++;
  const name = getName(req);
  const viewKey = generateKey(16);
  const deleteKey = generateKey();

  const user = {
    id,
    name,
    position,
    viewKey,
    deleteKey,
    joined: new Date().toISOString(),
    device: req.headers["user-agent"],
    ip,
    risk,
    registered: false,
  };

  users.set(id, user);
  res.cookie("userToken", id);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(user, null, 2));
});

// TEST ROUTE — no position (special users)
app.get("/test", (req, res) => {
  if (!requireAdminKey(req, res)) return;

  const id = getUniqueId();
  const name = getName(req);
  const viewKey = generateKey(16);
  const deleteKey = generateKey();

  const user = {
    id,
    name,
    position: null,
    viewKey,
    deleteKey,
    joined: new Date().toISOString(),
    device: req.headers["user-agent"],
    ip: "TEST",
    risk: 0,
    registered: false,
    test: true,
  };

  users.set(id, user);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(user, null, 2));
});

// ADMIN ROUTE — creates admin account with no position
app.get("/admin", (req, res) => {
  if (!requireAdminKey(req, res)) return;

  const id = getUniqueId();
  const name = req.query.name || "Admin";
  const viewKey = generateKey(16);
  const deleteKey = generateKey();

  const user = {
    id,
    name,
    position: null,
    viewKey,
    deleteKey,
    joined: new Date().toISOString(),
    device: req.headers["user-agent"],
    ip: "ADMIN",
    risk: 0,
    registered: false,
    admin: true,
  };

  users.set(id, user);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(user, null, 2));
});

function buildTableRows(userList, showPosition) {
  let rows = "";
  userList.forEach((u) => {
    const label = u.admin ? " (ADMIN)" : u.test || u.ip === "TEST" ? " (TEST)" : "";
    rows += `<tr>
      ${showPosition ? `<td>${u.position ?? "—"}</td>` : ""}
      <td>${u.id}${label}</td>
      <td>${u.name}</td>
      <td>${u.registered ? "yes" : "no"}</td>
      <td>${u.ip}</td>
    </tr>`;
  });
  return rows;
}

// LEADERBOARD — people (/counter) vs special (/test + /admin)
app.get("/leaderboard", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const rankedUsers = [...users.values()]
    .filter(isRankedUser)
    .sort((a, b) => a.position - b.position);

  const specialUsers = [...users.values()]
    .filter(isSpecialUser)
    .sort((a, b) => new Date(a.joined) - new Date(b.joined));

  const refreshInterval = 5;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Leaderboard</title>
        <meta http-equiv="refresh" content="${refreshInterval}">
        <style>
          body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 16px; }
          h1, h2 { margin-top: 24px; }
          table { border-collapse: collapse; width: 100%; margin-bottom: 32px; }
          th, td { border: 1px solid #ccc; padding: 6px; text-align: left; }
          th { background-color: #f0f0f0; }
        </style>
      </head>
      <body>
        <h1>Leaderboard</h1>

        <h2>People (/counter)</h2>
        <table>
          <tr>
            <th>Position</th>
            <th>ID</th>
            <th>Name</th>
            <th>Registered</th>
            <th>IP</th>
          </tr>
          ${buildTableRows(rankedUsers, true)}
        </table>

        <h2>Test &amp; Admin (/test, /admin)</h2>
        <table>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Registered</th>
            <th>IP</th>
          </tr>
          ${buildTableRows(specialUsers, false)}
        </table>
      </body>
    </html>
  `;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

app.get("/user/:id", (req, res) => {
  const { id } = req.params;
  const key = req.query.key;
  const user = users.get(id);
  if (!user) return res.status(404).json({ error: "Invalid or expired ID" });
  if (key !== user.viewKey && key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Invalid key" });
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Refresh", "5");
  res.send(JSON.stringify(user, null, 2));
});

app.get("/register/:id", (req, res) => {
  const { id } = req.params;
  const user = users.get(id);
  if (!user) return res.status(404).json({ error: "Invalid or expired ID" });

  user.registered = true;
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(user, null, 2));
});

app.get("/delete/:id", (req, res) => {
  const { id } = req.params;
  const key = req.query.key;

  const user = users.get(id);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (!user.registered && key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Must register before deleting" });
  }

  if (key !== user.deleteKey && key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Invalid key" });
  }

  users.delete(id);
  recalculatePositions();

  const remainingUsers = [...users.values()].sort((a, b) => {
    if (isRankedUser(a) && isRankedUser(b)) return a.position - b.position;
    return new Date(a.joined) - new Date(b.joined);
  });

  res.setHeader("Content-Type", "application/json");
  res.send(
    JSON.stringify({ success: true, deletedId: id, users: remainingUsers }, null, 2)
  );
});

app.get("/", (req, res) => {
  res.send("Counter API is running.");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
