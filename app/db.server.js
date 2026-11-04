import { PrismaClient } from "@prisma/client";

// Neon pauses an idle database, and the first connection after a pause can take a few seconds or
// time out ("Can't reach database server"). So: allow longer to connect, and quietly retry
// connection-level failures a few times before an error ever reaches the page.
const withTimeout = (raw) => {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (!u.searchParams.has("connect_timeout")) u.searchParams.set("connect_timeout", "20");
    return u.toString();
  } catch {
    return raw;
  }
};

// P1001 can't reach · P1002 timed out · P1008 operation timed out · P1017 server closed the connection.
// Errors raised while first connecting have no code, so those are recognised by type/message.
// A wrong password or missing database (P1000, P1003) is never retried: waiting won't fix it.
const RETRYABLE = new Set(["P1001", "P1002", "P1008", "P1017"]);
const NEVER = new Set(["P1000", "P1003"]);
const isConnectionError = (e) => {
  const code = e?.code ?? e?.errorCode;
  if (NEVER.has(code)) return false;
  return RETRYABLE.has(code) || e?.name === "PrismaClientInitializationError" || /Can't reach database server|Timed out fetching a new connection/i.test(e?.message || "");
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createClient() {
  const url = withTimeout(process.env.DATABASE_URL);
  const base = new PrismaClient(url ? { datasourceUrl: url } : undefined);
  return base.$extends({
    query: {
      async $allOperations({ args, query }) {
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await query(args);
          } catch (e) {
            if (!isConnectionError(e) || attempt >= 3) throw e;
            await wait(700 * 2 ** attempt); // 0.7s, 1.4s, 2.8s
          }
        }
      },
    },
  });
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createClient();
  }
}

const prisma = global.prismaGlobal ?? createClient();

export default prisma;
