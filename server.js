const express = require("express");
const axios = require("axios");
const cookieParser = require("cookie-parser");
const store = require("./store");

const ADMIN_KEY = process.env.ADMIN_KEY;
const STAFF_DELETE_KEY = process.env.STAFF_DELETE_KEY;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cookieParser());

const ipCountryCache = new Map();

function isRankedUser(user) {
  return (
    user.position != null &&
    !user.admin &&
    !user.test &&
    user.ip !== "TEST" &&
    user.ip !== "ADMIN"
  );
}

function isSpecialUser(user) {
  return user.admin || user.test || user.ip === "TEST" || user.ip === "ADMIN";
}

async function recalculatePositions() {
  const all = await store.getAllUsers();
  const ranked = all.filter(isRankedUser).sort((a, b) => a.position - b.position);

  for (let index = 0; index < ranked.length; index++) {
    ranked[index].position = index + 1;
    await store.saveUser(ranked[index]);
  }

  await store.setPositionCounter(ranked.length + 1);
}

function generateId() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function generateKey(length = 20) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let key = "";
  for (let i = 0; i < length; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

async function getUniqueId() {
  let id;
  do {
    id = generateId();
  } while (await store.idExists(id));
  return id;
}

function getIP(req) {
  let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (!ip) return null;
  if (ip.includes(",")) ip = ip.split(",")[0].trim();
  if (ip === "::1") return "127.0.0.1";
  if (ip.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");
  return ip;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function getCountryCode(ip) {
  if (!ip || ip === "TEST" || ip === "ADMIN" || ip === "127.0.0.1") {
    return null;
  }
  if (ipCountryCache.has(ip)) return ipCountryCache.get(ip);

  try {
    const res = await axios.get(
      `http://ip-api.com/json/${ip}?fields=status,countryCode`,
      { timeout: 3000 }
    );
    const code = res.data.status === "success" ? res.data.countryCode : null;
    ipCountryCache.set(ip, code);
    return code;
  } catch {
    ipCountryCache.set(ip, null);
    return null;
  }
}

function displayCountryCode(code) {
  if (code === "GB") return "UK";
  if (code === "US") return "USA";
  return code;
}

function formatIpDisplay(ip) {
  if (!ip || ip === "TEST" || ip === "ADMIN") return ip;
  const country = ipCountryCache.get(ip);
  return country ? `${ip} (${displayCountryCode(country)})` : ip;
}

async function prefetchCountries(userList) {
  const ips = [
    ...new Set(
      userList
        .map((u) => u.ip)
        .filter((ip) => ip && ip !== "TEST" && ip !== "ADMIN")
    ),
  ];
  await Promise.all(ips.map((ip) => getCountryCode(ip)));
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

async function canDelete(targetId, key) {
  const user = await store.getUser(targetId);
  if (!user) return { ok: false, status: 404, error: "User not found" };

  if (key === ADMIN_KEY) {
    return { ok: true, user, mode: "admin" };
  }

  if (key === STAFF_DELETE_KEY) {
    if (key === user.deleteKey) {
      return {
        ok: false,
        status: 403,
        error:
          "Use your personal deleteKey to remove your own account, not the staff key",
      };
    }
    if (user.admin) {
      return {
        ok: false,
        status: 403,
        error: "Staff key cannot delete admin accounts",
      };
    }
    if (!user.registered) {
      return {
        ok: false,
        status: 403,
        error: "Can only delete registered accounts with the staff key",
      };
    }
    return { ok: true, user, mode: "staff" };
  }

  if (key === user.deleteKey) {
    if (!user.registered) {
      return {
        ok: false,
        status: 403,
        error: "Must register before deleting your account",
      };
    }
    return { ok: true, user, mode: "self" };
  }

  return { ok: false, status: 403, error: "Invalid key" };
}

async function performDelete(targetId) {
  await store.deleteUser(targetId);
  await recalculatePositions();
}

setInterval(async () => {
  const now = Date.now();
  let deleted = false;
  const all = await store.getAllUsers();

  for (const user of all) {
    if (
      !user.registered &&
      now - new Date(user.joined).getTime() > 180000
    ) {
      await store.deleteUser(user.id);
      deleted = true;
      console.log(`Deleted expired user: ${user.id}`);
    }
  }

  if (deleted) await recalculatePositions();
}, 10000);

function getName(req) {
  const userAgent = req.headers["user-agent"] || "";
  if (userAgent.includes("Shortcuts")) return "ShortcutUser";
  if (req.query.name) return req.query.name;
  return "User";
}

function requireAdminKey(req, res) {
  if (req.query.key !== ADMIN_KEY) {
    res.status(403).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

app.get("/counter", async (req, res) => {
  const ip = getIP(req);
  if (!ip) return res.status(400).json({ error: "Could not determine IP" });

  const userToken = req.cookies?.userToken;
  if (userToken) {
    const existingUser = await store.getUser(userToken);
    if (existingUser) {
      res.cookie("userToken", existingUser.id);
      res.setHeader("Content-Type", "application/json");
      return res.send(JSON.stringify(existingUser, null, 2));
    }
  }

  const { risk } = await checkIP(ip);
  if (risk >= 50) return res.status(403).json({ error: "VPN/Proxy detected" });

  const all = await store.getAllUsers();
  const existingUser = all
    .filter((u) => u.ip === ip && isRankedUser(u))
    .sort((a, b) => new Date(a.joined) - new Date(b.joined))[0];

  if (existingUser) {
    res.cookie("userToken", existingUser.id);
    res.setHeader("Content-Type", "application/json");
    return res.send(JSON.stringify(existingUser, null, 2));
  }

  const id = await getUniqueId();
  let positionCounter = await store.getPositionCounter();
  const position = positionCounter++;
  await store.setPositionCounter(positionCounter);

  const user = {
    id,
    name: getName(req),
    position,
    viewKey: generateKey(16),
    deleteKey: generateKey(),
    joined: new Date().toISOString(),
    device: req.headers["user-agent"],
    ip,
    risk,
    registered: false,
  };

  await store.saveUser(user);
  res.cookie("userToken", id);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(user, null, 2));
});

app.get("/test", async (req, res) => {
  if (!requireAdminKey(req, res)) return;

  const user = {
    id: await getUniqueId(),
    name: getName(req),
    position: null,
    viewKey: generateKey(16),
    deleteKey: generateKey(),
    joined: new Date().toISOString(),
    device: req.headers["user-agent"],
    ip: "TEST",
    risk: 0,
    registered: false,
    test: true,
  };

  await store.saveUser(user);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(user, null, 2));
});

app.get("/admin", async (req, res) => {
  if (!requireAdminKey(req, res)) return;

  const user = {
    id: await getUniqueId(),
    name: req.query.name || "Admin",
    position: null,
    viewKey: generateKey(16),
    deleteKey: generateKey(),
    joined: new Date().toISOString(),
    device: req.headers["user-agent"],
    ip: "ADMIN",
    risk: 0,
    registered: false,
    admin: true,
  };

  await store.saveUser(user);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(user, null, 2));
});

function buildTableRows(userList, showPosition) {
  let rows = "";
  userList.forEach((u) => {
    const label = u.admin
      ? " (ADMIN)"
      : u.test || u.ip === "TEST"
        ? " (TEST)"
        : "";
    rows += `<tr>
      ${showPosition ? `<td>${u.position ?? "—"}</td>` : ""}
      <td>${escapeHtml(u.id)}${label}</td>
      <td>${escapeHtml(u.name)}</td>
      <td>${u.registered ? "yes" : "no"}</td>
      <td>${escapeHtml(formatIpDisplay(u.ip))}</td>
    </tr>`;
  });
  return rows;
}

app.get("/leaderboard", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const all = await store.getAllUsers();
  const rankedUsers = all.filter(isRankedUser).sort((a, b) => a.position - b.position);
  const specialUsers = all
    .filter(isSpecialUser)
    .sort((a, b) => new Date(a.joined) - new Date(b.joined));

  await prefetchCountries([...rankedUsers, ...specialUsers]);

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Leaderboard</title>
        <meta http-equiv="refresh" content="5">
        <style>
          body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 16px; }
          h1, h2 { margin-top: 24px; }
          table { border-collapse: collapse; width: 100%; margin-bottom: 32px; }
          th, td { border: 1px solid #ccc; padding: 6px; text-align: left; }
          th { background-color: #f0f0f0; }
          .danger { color: #b00020; }
          a.btn { display: inline-block; padding: 8px 14px; background: #b00020; color: #fff; text-decoration: none; border-radius: 4px; }
          a.btn:hover { background: #8b0019; }
          .muted { color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <h1>Leaderboard</h1>
        <h2>People (/counter)</h2>
        <table>
          <tr><th>Position</th><th>ID</th><th>Name</th><th>Registered</th><th>IP</th></tr>
          ${buildTableRows(rankedUsers, true)}
        </table>
        <h2>Test &amp; Admin (/test, /admin)</h2>
        <table>
          <tr><th>ID</th><th>Name</th><th>Registered</th><th>IP</th></tr>
          ${buildTableRows(specialUsers, false)}
        </table>
      </body>
    </html>
  `;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

app.get("/delete", async (req, res) => {
  const key = req.query.key;
  if (!key) {
    return res.status(400).send("Missing ?key= (your deleteKey or staff delete key)");
  }

  const safeKey = encodeURIComponent(key);
  const deleted = req.query.deleted === "1";
  const error = req.query.error ? escapeHtml(req.query.error) : "";

  let body = "";

  if (deleted) {
    body += `<p class="danger"><strong>Account deleted successfully.</strong></p>`;
  }
  if (error) {
    body += `<p class="danger">${error}</p>`;
  }

  if (key === STAFF_DELETE_KEY) {
    if (!STAFF_DELETE_KEY) {
      return res.status(500).send("STAFF_DELETE_KEY is not configured on the server");
    }

    const all = await store.getAllUsers();
    const targets = all
      .filter((u) => u.registered && !u.admin)
      .sort((a, b) => new Date(a.joined) - new Date(b.joined));

    body += `<h1>Staff delete</h1>
      <p class="muted">Remove other <strong>registered</strong> accounts. To delete your own admin account, use the <code>deleteKey</code> from when you ran <code>/admin</code> — not this key.</p>`;

    if (!targets.length) {
      body += `<p>No registered users to delete.</p>`;
    } else {
      body += `<table>
        <tr><th>ID</th><th>Name</th><th>IP</th><th></th></tr>`;
      for (const u of targets) {
        body += `<tr>
          <td>${escapeHtml(u.id)}</td>
          <td>${escapeHtml(u.name)}</td>
          <td>${escapeHtml(u.ip)}</td>
          <td><a class="btn" href="/delete/${escapeHtml(u.id)}?key=${safeKey}&amp;from=web">Delete</a></td>
        </tr>`;
      }
      body += `</table>`;
    }
  } else {
    const owner = await store.getUserByDeleteKey(key);
    if (!owner) {
      return res.status(403).send("Invalid delete key");
    }

    body += `<h1>Delete your account</h1>
      <p><strong>ID:</strong> ${escapeHtml(owner.id)}<br>
      <strong>Name:</strong> ${escapeHtml(owner.name)}<br>
      <strong>Registered:</strong> ${owner.registered ? "yes" : "no"}</p>`;

    if (!owner.registered) {
      body += `<p class="danger">Register first (<code>/register/${escapeHtml(owner.id)}</code>), then you can delete.</p>`;
    } else {
      body += `<p><a class="btn" href="/delete/${escapeHtml(owner.id)}?key=${safeKey}&amp;from=web">Delete my account</a></p>`;
    }
  }

  const html = `<!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Delete account</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 16px; }
          table { border-collapse: collapse; width: 100%; margin-top: 16px; }
          th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
          th { background: #f0f0f0; }
          .danger { color: #b00020; }
          a.btn { display: inline-block; padding: 8px 14px; background: #b00020; color: #fff; text-decoration: none; border-radius: 4px; }
          .muted { color: #666; font-size: 14px; }
          code { background: #f4f4f4; padding: 2px 6px; }
        </style>
      </head>
      <body>${body}</body>
    </html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

async function findRankedUserByPosition(positionParam) {
  const position = parseInt(positionParam, 10);
  if (!Number.isFinite(position) || position < 1) {
    return { ok: false, status: 400, error: "Invalid position number" };
  }

  const all = await store.getAllUsers();
  const user = all.find((u) => isRankedUser(u) && u.position === position);

  if (!user) {
    return { ok: false, status: 404, error: "No user at that position" };
  }

  return { ok: true, user };
}

app.get("/user/position/:position", async (req, res) => {
  const key = req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const lookup = await findRankedUserByPosition(req.params.position);
  if (!lookup.ok) {
    return res.status(lookup.status).json({ error: lookup.error });
  }

  const user = lookup.user;

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Refresh", "5");
  res.send(JSON.stringify(user, null, 2));
});

app.get("/user/:id", async (req, res) => {
  const { id } = req.params;
  const key = req.query.key;
  const user = await store.getUser(id);
  if (!user) return res.status(404).json({ error: "Invalid or expired ID" });
  if (key !== user.viewKey && key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Invalid key" });
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Refresh", "5");
  res.send(JSON.stringify(user, null, 2));
});

app.get("/register/:id", async (req, res) => {
  const { id } = req.params;
  const user = await store.getUser(id);
  if (!user) return res.status(404).json({ error: "Invalid or expired ID" });

  user.registered = true;
  await store.saveUser(user);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(user, null, 2));
});

app.get("/delete/position/:position", async (req, res) => {
  const key = req.query.key;
  const fromWeb = req.query.from === "web";

  const lookup = await findRankedUserByPosition(req.params.position);
  if (!lookup.ok) {
    return res.status(lookup.status).json({ error: lookup.error });
  }

  const id = lookup.user.id;
  const check = await canDelete(id, key);
  if (!check.ok) {
    if (fromWeb) {
      const safeKey = encodeURIComponent(key);
      return res.redirect(
        `/delete?key=${safeKey}&error=${encodeURIComponent(check.error)}`
      );
    }
    return res.status(check.status).json({ error: check.error });
  }

  await performDelete(id);

  if (fromWeb) {
    const safeKey = encodeURIComponent(key);
    return res.redirect(`/delete?key=${safeKey}&deleted=1`);
  }

  const remainingUsers = (await store.getAllUsers()).sort((a, b) => {
    if (isRankedUser(a) && isRankedUser(b)) return a.position - b.position;
    return new Date(a.joined) - new Date(b.joined);
  });

  res.setHeader("Content-Type", "application/json");
  res.send(
    JSON.stringify(
      { success: true, deletedId: id, position: lookup.user.position, users: remainingUsers },
      null,
      2
    )
  );
});

app.get("/delete/:id", async (req, res) => {
  const { id } = req.params;
  const key = req.query.key;
  const fromWeb = req.query.from === "web";

  const check = await canDelete(id, key);
  if (!check.ok) {
    if (fromWeb) {
      const safeKey = encodeURIComponent(key);
      return res.redirect(
        `/delete?key=${safeKey}&error=${encodeURIComponent(check.error)}`
      );
    }
    return res.status(check.status).json({ error: check.error });
  }

  await performDelete(id);

  if (fromWeb) {
    const safeKey = encodeURIComponent(key);
    return res.redirect(`/delete?key=${safeKey}&deleted=1`);
  }

  const remainingUsers = (await store.getAllUsers()).sort((a, b) => {
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

async function start() {
  if (!ADMIN_KEY) {
    console.error("ADMIN_KEY environment variable is required");
    process.exit(1);
  }

  await store.initStore();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
