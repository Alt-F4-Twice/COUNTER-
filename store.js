const { createClient } = require("redis");

const PREFIX = "counter:";

let redis;
let memoryUsers = new Map();
let memoryDeleteKeys = new Map();
let memoryPositionCounter = 1;
let useMemory = false;

async function initStore() {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn("REDIS_URL not set — using in-memory storage (data lost on restart)");
    useMemory = true;
    return;
  }

  redis = createClient({ url });
  redis.on("error", (err) => console.error("Redis error:", err));
  await redis.connect();
  console.log("Connected to Redis");
}

function userKey(id) {
  return `${PREFIX}user:${id}`;
}

function deleteKeyIndex(key) {
  return `${PREFIX}deleteKey:${key}`;
}

function idsKey() {
  return `${PREFIX}userIds`;
}

function positionCounterKey() {
  return `${PREFIX}positionCounter`;
}

async function getAllUsers() {
  if (useMemory) return [...memoryUsers.values()];

  const ids = await redis.sMembers(idsKey());
  if (!ids.length) return [];

  const users = [];
  for (const id of ids) {
    const raw = await redis.get(userKey(id));
    if (raw) users.push(JSON.parse(raw));
  }
  return users;
}

async function getUser(id) {
  if (useMemory) return memoryUsers.get(id) || null;

  const raw = await redis.get(userKey(id));
  return raw ? JSON.parse(raw) : null;
}

async function getUserByDeleteKey(key) {
  if (!key) return null;
  if (useMemory) {
    const id = memoryDeleteKeys.get(key);
    return id ? memoryUsers.get(id) || null : null;
  }

  const id = await redis.get(deleteKeyIndex(key));
  if (!id) return null;
  return getUser(id);
}

async function saveUser(user) {
  if (useMemory) {
    memoryUsers.set(user.id, user);
    memoryDeleteKeys.set(user.deleteKey, user.id);
    return;
  }

  await redis.set(userKey(user.id), JSON.stringify(user));
  await redis.set(deleteKeyIndex(user.deleteKey), user.id);
  await redis.sAdd(idsKey(), user.id);
}

async function deleteUser(id) {
  const user = await getUser(id);
  if (!user) return false;

  if (useMemory) {
    memoryUsers.delete(id);
    memoryDeleteKeys.delete(user.deleteKey);
    return true;
  }

  await redis.del(userKey(id));
  await redis.del(deleteKeyIndex(user.deleteKey));
  await redis.sRem(idsKey(), id);
  return true;
}

async function idExists(id) {
  if (useMemory) return memoryUsers.has(id);
  return redis.sIsMember(idsKey(), id);
}

async function getPositionCounter() {
  if (useMemory) return memoryPositionCounter;

  const raw = await redis.get(positionCounterKey());
  return raw ? parseInt(raw, 10) : 1;
}

async function setPositionCounter(value) {
  if (useMemory) {
    memoryPositionCounter = value;
    return;
  }
  await redis.set(positionCounterKey(), String(value));
}

module.exports = {
  initStore,
  getAllUsers,
  getUser,
  getUserByDeleteKey,
  saveUser,
  deleteUser,
  idExists,
  getPositionCounter,
  setPositionCounter,
};
