const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const root = __dirname;
const dataDirectory = path.join(root, "data");
const dataFile = path.join(dataDirectory, "scorezone.json");
const port = Number(process.env.PORT || 3000);

function createInitialState() {
  return {
    matches: [
      { id: 1, sport: "Cricket", status: "Live", a: "India", b: "Australia", sa: "185/4", sb: "162/6", detail: "30.2 overs · World Cup", venue: "Ahmedabad", saved: true },
      { id: 2, sport: "Football", status: "Live", a: "Man City", b: "Arsenal", sa: "2", sb: "1", detail: "67' · Premier League", venue: "Manchester", saved: true },
      { id: 3, sport: "Tennis", status: "Live", a: "Sinner", b: "Alcaraz", sa: "6  4", sb: "4  3", detail: "Set 2 · Semi-final", venue: "Centre Court", saved: false },
      { id: 4, sport: "Basketball", status: "Live", a: "Lakers", b: "Warriors", sa: "89", sb: "92", detail: "Q4 · NBA", venue: "Los Angeles", saved: false },
      { id: 5, sport: "Cricket", status: "Upcoming", a: "England", b: "Pakistan", sa: "—", sb: "—", detail: "Today · 19:30", venue: "Lahore", saved: false },
      { id: 6, sport: "Football", status: "Upcoming", a: "Barcelona", b: "Real Madrid", sa: "—", sb: "—", detail: "Tomorrow · 20:00", venue: "Barcelona", saved: false }
    ],
    settings: { startAlerts: true, scoreAlerts: true, eventAlerts: false },
    events: [
      { id: 1, icon: "🏏", title: "Wicket! Australia take a breakthrough", detail: "India vs Australia · caught at deep mid-wicket", createdAt: new Date(Date.now() - 2 * 60_000).toISOString() },
      { id: 2, icon: "⚽", title: "GOAL! Manchester City", detail: "Man City vs Arsenal · 67th minute", createdAt: new Date(Date.now() - 5 * 60_000).toISOString() },
      { id: 3, icon: "🎾", title: "Set point converted", detail: "Sinner vs Alcaraz · second set", createdAt: new Date(Date.now() - 8 * 60_000).toISOString() }
    ],
    updateCount: 28
  };
}

let state;
let writeQueue = Promise.resolve();

async function persistState() {
  const write = async () => {
    await fs.mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${dataFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temporaryFile, dataFile);
  };
  writeQueue = writeQueue.then(write, write);
  return writeQueue;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10_000) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.status = 400;
    throw error;
  }
}

function getStateSnapshot() {
  return {
    matches: state.matches,
    settings: state.settings,
    events: state.events,
    updateCount: state.updateCount
  };
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, getStateSnapshot());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/refresh") {
    const featured = state.matches.find(match => match.id === 1);
    const [runs, wickets] = featured.sa.split("/").map(Number);
    featured.sa = `${runs + 1}/${wickets}`;
    state.updateCount += 1;
    state.events.unshift({
      id: Date.now(),
      icon: "🏏",
      title: "Score updated · India",
      detail: `India vs Australia · ${featured.sa} · ${featured.detail}`,
      createdAt: new Date().toISOString()
    });
    state.events = state.events.slice(0, 10);
    await persistState();
    sendJson(response, 200, getStateSnapshot());
    return;
  }

  const followMatch = url.pathname.match(/^\/api\/matches\/(\d+)\/follow$/);
  if (request.method === "PUT" && followMatch) {
    const match = state.matches.find(item => item.id === Number(followMatch[1]));
    if (!match) {
      sendJson(response, 404, { error: "Match not found" });
      return;
    }
    const body = await readJson(request);
    if (typeof body.followed !== "boolean") {
      sendJson(response, 400, { error: "followed must be a boolean" });
      return;
    }
    match.saved = body.followed;
    await persistState();
    sendJson(response, 200, getStateSnapshot());
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/settings") {
    const body = await readJson(request);
    const keys = ["startAlerts", "scoreAlerts", "eventAlerts"];
    if (!keys.every(key => typeof body[key] === "boolean")) {
      sendJson(response, 400, { error: "All notification preferences must be booleans" });
      return;
    }
    state.settings = Object.fromEntries(keys.map(key => [key, body[key]]));
    await persistState();
    sendJson(response, 200, getStateSnapshot());
    return;
  }

  sendJson(response, 404, { error: "API route not found" });
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function serveStatic(url, response) {
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  if (relativePath !== "index.html") {
    sendJson(response, 404, { error: "File not found" });
    return;
  }
  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      sendJson(response, 404, { error: "File not found" });
      return;
    }
    throw error;
  }
}

async function start() {
  try {
    const savedState = await fs.readFile(dataFile, "utf8");
    state = JSON.parse(savedState);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not load ${dataFile}: ${error.message}`);
    }
    state = createInitialState();
    await persistState();
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
      } else if (request.method === "GET" || request.method === "HEAD") {
        await serveStatic(url, response);
      } else {
        sendJson(response, 405, { error: "Method not allowed" });
      }
    } catch (error) {
      if (error.status) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error("Request failed:", error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: "The server could not complete the request" });
      } else {
        response.destroy(error);
      }
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`ScoreZone is running at http://localhost:${port}`);
  });
}

start().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
