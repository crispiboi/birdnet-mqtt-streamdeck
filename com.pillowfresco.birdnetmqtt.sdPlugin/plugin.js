/* global WebSocket, atob */

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const ACTION_TEXT = "com.pillowfresco.birdnetmqtt.lastdetection";
const ACTION_IMAGE = "com.pillowfresco.birdnetmqtt.image";
const ACTION_BORDER = "com.pillowfresco.birdnetmqtt.border";
const ACTION_TODAY = "com.pillowfresco.birdnetmqtt.today";

const DEFAULTS = {
  mqttHost: "mqtt://localhost",
  mqttPort: 1883,
  mqttTopic: "birdnet",
  mqttClientId: "streamdeck-birdnet",
  mqttUsername: "",
  mqttPassword: "",
  mqttTls: false,
  payloadKey: "CommonName",
  rotationSeconds: 4,
  epicOccurrenceThreshold: 0.1,
  rareOccurrenceThreshold: 0.4,
  uncommonOccurrenceThreshold: 0.7,
  rareHoldMultiplier: 2
};

let websocket = null;
let uuid = null;
let actionContext = null;
const contexts = new Map();
let settings = { ...DEFAULTS };
let globalSettings = { ...DEFAULTS };
let globalSettingsLoaded = false;
let mqttClient = null;
let mqttLib = null;
const detectionTimestamps = [];
const imageCache = new Map();
const imageInFlight = new Map();
const dailyBirds = new Map();
const rotationState = new Map();
let latestDetection = null;
let latestImageUrl = null;
const logFile = path.join(__dirname, "birdnet-mqtt-plugin.log");
const pendingLogs = [];
const cacheFile = path.join(__dirname, "birdnet-mqtt-cache.json");
let cacheSaveTimer = null;

function logLine(message) {
  const ts = new Date().toISOString();
  const line = `[birdnet-mqtt] ${ts} ${message}`;
  try {
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
  } catch (err) {
    // ignore logging failures
  }
  sendLogMessage(line);
}

logLine("plugin loaded");
loadCache();

function loadCache() {
  try {
    if (!fs.existsSync(cacheFile)) {
      return;
    }
    const raw = fs.readFileSync(cacheFile, "utf8").trim();
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw);
    const todayKey = new Date().toISOString().slice(0, 10);
    if (data && data.dateKey === todayKey && Array.isArray(data.birds)) {
      const dayMap = new Map();
      data.birds.forEach((record) => {
        if (!record || !record.name) {
          return;
        }
        dayMap.set(record.name, {
          name: record.name,
          occurrence: typeof record.occurrence === "number" ? record.occurrence : null,
          confidence: typeof record.confidence === "number" ? record.confidence : null,
          lastSeen: typeof record.lastSeen === "number" ? record.lastSeen : Date.now()
        });
      });
      if (dayMap.size) {
        dailyBirds.set(todayKey, dayMap);
      }
    }
    if (data && data.latestDetection && data.latestDetection.name) {
      latestDetection = data.latestDetection;
    }
    if (data && typeof data.latestImageUrl === "string") {
      latestImageUrl = data.latestImageUrl;
    }
    logLine("cache loaded");
  } catch (err) {
    logLine(`cache load failed ${err && err.message ? err.message : err}`);
  }
}

function scheduleCacheSave() {
  if (cacheSaveTimer) {
    return;
  }
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    saveCache();
  }, 1000);
}

function saveCache() {
  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    const dayMap = dailyBirds.get(todayKey);
    const birds = dayMap ? Array.from(dayMap.values()) : [];
    const payload = {
      dateKey: todayKey,
      birds,
      latestDetection: latestDetection || null,
      latestImageUrl: latestImageUrl || null
    };
    fs.writeFileSync(cacheFile, JSON.stringify(payload), "utf8");
  } catch (err) {
    logLine(`cache save failed ${err && err.message ? err.message : err}`);
  }
}

process.on("uncaughtException", (err) => {
  logLine(`uncaughtException ${err && err.stack ? err.stack : err}`);
});

process.on("unhandledRejection", (err) => {
  logLine(`unhandledRejection ${err && err.stack ? err.stack : err}`);
});

function parseActionInfo(inActionInfo) {
  if (!inActionInfo) {
    return null;
  }
  if (typeof inActionInfo === "object") {
    return inActionInfo;
  }
  try {
    return JSON.parse(inActionInfo);
  } catch (err) {
    try {
      return JSON.parse(decodeURIComponent(inActionInfo));
    } catch (err2) {
      return null;
    }
  }
}

function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
  uuid = inUUID;
  const actionInfo = parseActionInfo(inActionInfo);
  actionContext = actionInfo && actionInfo.context ? actionInfo.context : actionContext;
  logLine(`connect uuid=${uuid} context=${actionContext}`);

  websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);

  websocket.onopen = () => {
    const register = {
      event: inRegisterEvent,
      uuid: inUUID
    };
    websocket.send(JSON.stringify(register));
    logLine(`registered event=${inRegisterEvent}`);
    flushPendingLogs();
    websocket.send(JSON.stringify({
      event: "getGlobalSettings",
      context: uuid
    }));
  };

  websocket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    logLine(`event=${message.event} context=${message.context || ""}`);

    if (message.context && message.action) {
      contexts.set(message.context, message.action);
    }

    if (message.event === "didReceiveSettings") {
      settings = { ...DEFAULTS, ...globalSettings, ...(message.payload.settings || {}) };
      logLine(`didReceiveSettings ${JSON.stringify(settings)}`);
      restartMqtt();
    }

    if (message.event === "didReceiveGlobalSettings") {
      globalSettings = { ...DEFAULTS, ...(message.payload.settings || {}) };
      globalSettingsLoaded = true;
      settings = { ...DEFAULTS, ...globalSettings, ...(message.payload.settings || {}) };
      logLine(`didReceiveGlobalSettings ${JSON.stringify(globalSettings)}`);
      restartMqtt();
    }

    if (message.event === "willAppear") {
      actionContext = message.context;
      if (message.context && message.action) {
        contexts.set(message.context, message.action);
      }
      settings = { ...DEFAULTS, ...globalSettings, ...(message.payload.settings || {}) };
      logLine(`willAppear ${JSON.stringify(settings)}`);
      restartMqtt();
      if (!globalSettingsLoaded) {
        websocket.send(JSON.stringify({
          event: "getGlobalSettings",
          context: uuid
        }));
      }
      if (message.action === ACTION_TODAY && message.context) {
        startRotation(message.context);
      }
      if ((message.action === ACTION_TEXT || message.action === ACTION_BORDER) && latestDetection) {
        const display = formatTitle(
          latestDetection.name,
          latestDetection.confidence,
          getDetectionsLastHour(),
          latestDetection.occurrence
        );
        setImageTitle(message.context, display, message.action === ACTION_BORDER ? "border" : "text");
      }
      if (message.action === ACTION_IMAGE && latestImageUrl) {
        updateImageContexts(
          latestImageUrl,
          message.context,
          latestDetection ? latestDetection.occurrence : null
        );
      }
    }

    if (message.event === "willDisappear") {
      if (message.context) {
        contexts.delete(message.context);
        stopRotation(message.context);
      }
    }

    if (message.event === "sendToPlugin") {
      actionContext = message.context || actionContext;
      if (message.payload && message.payload.settings) {
        settings = { ...DEFAULTS, ...(message.payload.settings || {}) };
        logLine(`sendToPlugin ${JSON.stringify(settings)}`);
        saveSettings();
        restartMqtt();
      }
    }

    if (message.event === "propertyInspectorDidAppear") {
      actionContext = message.context || actionContext;
      sendToPropertyInspector();
    }
  };
}

function sendLogMessage(message) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    pendingLogs.push(message);
    return;
  }

  websocket.send(JSON.stringify({
    event: "logMessage",
    payload: {
      message
    }
  }));
}

function flushPendingLogs() {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    return;
  }

  while (pendingLogs.length > 0) {
    const message = pendingLogs.shift();
    websocket.send(JSON.stringify({
      event: "logMessage",
      payload: {
        message
      }
    }));
  }
}

function restartMqtt() {
  if (mqttClient) {
    try {
      mqttClient.end(true);
    } catch (err) {
      // ignore
    }
  }

  const mqtt = loadMqtt();
  if (!mqtt) {
    forEachContext(null, (context, contextAction) => {
      if (contextAction !== ACTION_IMAGE) {
        setTitle(context, "MQTT\nERR");
      }
    });
    return;
  }

  const url = buildMqttUrl(settings);

  mqttClient = mqtt.connect(url, {
    clientId: settings.mqttClientId,
    username: settings.mqttUsername || undefined,
    password: settings.mqttPassword || undefined,
    reconnectPeriod: 5000
  });

  mqttClient.on("connect", () => {
    logLine(`mqtt connect ${url} topic=${settings.mqttTopic}`);
    mqttClient.subscribe(settings.mqttTopic, (err) => {
      if (err) {
        logLine(`mqtt subscribe error ${String(err && err.message ? err.message : err)}`);
        forEachContext(null, (context, contextAction) => {
          if (contextAction !== ACTION_IMAGE) {
            setTitle(context, "MQTT\nERR");
          }
        });
      } else {
        logLine(`mqtt subscribed ${settings.mqttTopic}`);
        forEachContext(null, (context, contextAction) => {
          if (contextAction !== ACTION_IMAGE) {
            setTitle(context, "Waiting\n...");
          }
        });
      }
    });
  });

  mqttClient.on("message", (_topic, payload, packet) => {
    const isRetained = Boolean(packet && packet.retain);
    logLine(`mqtt message topic=${_topic} bytes=${payload.length} retained=${isRetained}`);
    const detection = parsePayload(payload);
    if (detection && detection.name) {
      updateDailyBirds(detection);
      latestDetection = detection;
      if (detection.imageUrl) {
        latestImageUrl = detection.imageUrl;
      }
      if (!isRetained) {
        recordDetection();
      }

      const display = formatTitle(detection.name, detection.confidence, getDetectionsLastHour(), detection.occurrence);
      forEachContext(ACTION_TEXT, (context) => {
        logLine(`update text context=${context}`);
        setImageTitle(context, display, "text");
      });
      forEachContext(ACTION_BORDER, (context) => {
        logLine(`update border context=${context}`);
        setImageTitle(context, display, "border");
      });
      forEachContext(ACTION_TODAY, (context) => {
        if (!isRetained) {
          logLine(`update today context=${context}`);
          startRotation(context, true);
        }
      });
    }
    if (detection && detection.imageUrl) {
      if (!isRetained) {
        updateImageContexts(detection.imageUrl, null, detection.occurrence);
      }
    }
  });

  mqttClient.on("error", () => {
    logLine("mqtt error");
    forEachContext(null, (context, contextAction) => {
      if (contextAction !== ACTION_IMAGE) {
        setTitle(context, "MQTT\nERR");
      }
    });
  });

  mqttClient.on("close", () => {
    logLine("mqtt close");
  });

  mqttClient.on("offline", () => {
    logLine("mqtt offline");
  });

  mqttClient.on("reconnect", () => {
    logLine("mqtt reconnect");
  });
}

function loadMqtt() {
  if (mqttLib) {
    return mqttLib;
  }

  try {
    mqttLib = require("mqtt");
    logLine("mqtt module loaded");
    return mqttLib;
  } catch (err) {
    logLine(`mqtt require failed ${err && err.stack ? err.stack : err}`);
    return null;
  }
}

function buildMqttUrl(currentSettings) {
  const rawHost = (currentSettings.mqttHost || "").trim();
  const protocol = rawHost.startsWith("mqtts://")
    ? "mqtts"
    : rawHost.startsWith("mqtt://")
      ? "mqtt"
      : (currentSettings.mqttTls ? "mqtts" : "mqtt");
  const hostNoProto = rawHost.replace(/^mqtts?:\/\//, "");
  const hostOnly = hostNoProto.split("/")[0].split(":")[0] || "localhost";
  return `${protocol}://${hostOnly}:${currentSettings.mqttPort}`;
}

function parsePayload(payload) {
  const text = payload.toString("utf8").trim();
  if (!text) {
    return null;
  }

  let confidence = null;
  let imageUrl = null;
  let occurrence = null;
  let detectionDate = null;
  if (settings.payloadKey) {
    try {
      const json = JSON.parse(text);
      const value = getJsonPath(json, settings.payloadKey);
      if (value) {
        confidence = extractConfidence(json);
        imageUrl = extractImageUrl(json);
        occurrence = extractOccurrence(json);
        detectionDate = extractDate(json);
        return { name: String(value), confidence, imageUrl, occurrence, detectionDate };
      }
    } catch (err) {
      // fall back to heuristic
    }
  }

  try {
    const json = JSON.parse(text);
    confidence = extractConfidence(json);
    imageUrl = extractImageUrl(json);
    occurrence = extractOccurrence(json);
    detectionDate = extractDate(json);
    const candidates = [
      json.CommonName,
      json.ScientificName,
      json.SpeciesCode,
      json.common_name,
      json.commonName,
      json.species,
      json.scientific_name,
      json.scientificName,
      json.label,
      json.name,
      json.bird_name,
      json.detection,
      json.attributes && (json.attributes.common_name || json.attributes.species),
      json.event && (json.event.common_name || json.event.species),
      Array.isArray(json.results) && json.results[0] && (json.results[0].common_name || json.results[0].species)
    ];

    const found = candidates.find((value) => typeof value === "string" && value.trim().length > 0);
    if (found) {
      return { name: found, confidence, imageUrl, occurrence, detectionDate };
    }
  } catch (err) {
    // not JSON
  }

  return { name: text, confidence: null, imageUrl: null, occurrence: null, detectionDate: null };
}

function getJsonPath(obj, path) {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function formatTitle(name, confidence, count, occurrence) {
  const trimmed = name.trim();
  const nameMaxLen = 12;

  const nameLines = splitName(trimmed, nameMaxLen, 3);
  const line1 = nameLines[0] || "";
  const line2 = nameLines[1] || "";
  const line3 = nameLines[2] || "";

  return {
    line1,
    line2,
    line3,
    confidence: typeof confidence === "number" && !Number.isNaN(confidence) ? confidence : null,
    count: typeof count === "number" ? count : null,
    occurrence: typeof occurrence === "number" && !Number.isNaN(occurrence) ? occurrence : null,
    rare: typeof occurrence === "number" && !Number.isNaN(occurrence) && occurrence <= settings.rareOccurrenceThreshold
  };
}

function truncateToFit(text, maxLen) {
  if (text.length <= maxLen) {
    return text;
  }
  if (maxLen <= 3) {
    return text.slice(0, maxLen);
  }
  return `${text.slice(0, maxLen - 3)}...`;
}

function extractConfidence(json) {
  if (!json || typeof json !== "object") {
    return null;
  }
  const value =
    json.Confidence ??
    json.confidence ??
    (json.attributes && (json.attributes.confidence || json.attributes.Confidence)) ??
    (json.event && (json.event.confidence || json.event.Confidence));
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function extractImageUrl(json) {
  if (!json || typeof json !== "object") {
    return null;
  }
  const url =
    (json.BirdImage && (json.BirdImage.URL || json.BirdImage.Url || json.BirdImage.url)) ||
    (json.birdImage && (json.birdImage.URL || json.birdImage.url)) ||
    json.imageUrl ||
    json.image_url ||
    json.image;
  if (typeof url === "string" && url.trim().length > 0) {
    return url.trim();
  }
  return null;
}

function extractOccurrence(json) {
  if (!json || typeof json !== "object") {
    return null;
  }
  const value = json.occurrence ?? json.Occurrence;
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function extractDate(json) {
  if (!json || typeof json !== "object") {
    return null;
  }
  const value = json.Date || json.date;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function forEachContext(action, callback) {
  for (const [context, contextAction] of contexts) {
    if (!action || contextAction === action) {
      callback(context, contextAction);
    }
  }
}

function setTitle(context, title) {
  if (!websocket || !context) {
    return;
  }

  websocket.send(JSON.stringify({
    event: "setTitle",
    context: context,
    payload: {
      title: title,
      target: 0
    }
  }));
}

function setImageTitle(context, display, variant) {
  if (!websocket || !context) {
    return;
  }

  let svg = "";
  if (variant === "border") {
    svg = renderSvgBorder(display);
  } else if (variant === "today") {
    svg = renderSvgToday(display);
  } else {
    svg = renderSvg(display);
  }
  const dataUri = `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;

  websocket.send(JSON.stringify({
    event: "setImage",
    context: context,
    payload: {
      image: dataUri,
      target: 0
    }
  }));

  setTitle(context, "");
}

function setImage(context, image) {
  if (!websocket || !context) {
    return;
  }

  websocket.send(JSON.stringify({
    event: "setImage",
    context: context,
    payload: {
      image: image,
      target: 0
    }
  }));
}

function renderCommonalityShape(commonality, x, y, size) {
  const color = commonality.color || "#9ca3af";
  const stroke = "rgba(0,0,0,0.6)";
  const strokeWidth = 3;
  const half = size / 2;
  const left = x - half;
  const top = y - half;
  const right = x + half;
  const bottom = y + half;

  if (commonality.shape === "square") {
    return `<rect x="${left}" y="${top}" width="${size}" height="${size}" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}" rx="2" ry="2"/>`;
  }
  if (commonality.shape === "diamond") {
    return `<polygon points="${x},${top} ${right},${y} ${x},${bottom} ${left},${y}" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  }
  if (commonality.shape === "star") {
    const points = [];
    const outer = half;
    const inner = half * 0.45;
    for (let i = 0; i < 10; i += 1) {
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 === 0 ? outer : inner;
      points.push(`${x + r * Math.cos(angle)},${y + r * Math.sin(angle)}`);
    }
    return `<polygon points="${points.join(" ")}" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  }
  if (commonality.shape === "triangle") {
    return `<polygon points="${x},${top} ${right},${bottom} ${left},${bottom}" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  }
  if (commonality.shape === "hex") {
    const q = size * 0.28;
    return `<polygon points="${left + q},${top} ${right - q},${top} ${right},${y} ${right - q},${bottom} ${left + q},${bottom} ${left},${y}" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  }
  return `<circle cx="${x}" cy="${y}" r="${half}" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function renderImageWithDot(imageDataUri, occurrence) {
  if (!imageDataUri) {
    return imageDataUri;
  }
  const commonality = getCommonality(occurrence);
  const marker = renderCommonalityShape(commonality, 124, 124, 24);
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent([
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`,
    `<image href="${imageDataUri}" x="0" y="0" width="144" height="144" preserveAspectRatio="xMidYMid slice"/>`,
    `</svg>`
  ].join(""))}`;
}

function updateImageContexts(imageUrl, specificContext, occurrence) {
  if (!imageUrl) {
    return;
  }
  if (!specificContext) {
    let hasImageContext = false;
    forEachContext(ACTION_IMAGE, () => {
      hasImageContext = true;
    });
    if (!hasImageContext) {
      return;
    }
  }

  fetchImageData(imageUrl)
    .then((dataUri) => {
      const composed = renderImageWithDot(dataUri, occurrence);
      if (specificContext) {
        setImage(specificContext, composed);
        setTitle(specificContext, "");
      } else {
        forEachContext(ACTION_IMAGE, (context) => {
          setImage(context, composed);
          setTitle(context, "");
        });
      }
    })
    .catch((err) => {
      logLine(`image fetch error ${String(err && err.message ? err.message : err)}`);
    });
}

function fetchImageData(url) {
  if (imageCache.has(url)) {
    return Promise.resolve(imageCache.get(url));
  }
  if (imageInFlight.has(url)) {
    return imageInFlight.get(url);
  }
  if (typeof fetch !== "function") {
    return Promise.reject(new Error("fetch not available"));
  }

  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`http ${res.status}`);
      }
      const contentType = res.headers.get("content-type") || "image/jpeg";
      return res.arrayBuffer().then((buf) => {
        const base64 = Buffer.from(buf).toString("base64");
        const dataUri = `data:${contentType};base64,${base64}`;
        imageCache.set(url, dataUri);
        return dataUri;
      });
    })
    .finally(() => {
      imageInFlight.delete(url);
    });

  imageInFlight.set(url, promise);
  return promise;
}

function renderSvg(display) {
  const width = 144;
  const height = 144;
  const statsFont = 16;
  const pillY = 104;

  const line1 = escapeXml(display.line1 || "");
  const line2 = escapeXml(display.line2 || "");
  const line3 = escapeXml(display.line3 || "");
  const confPercent = display.confidence !== null ? Math.round(display.confidence * 100) : null;
  const confColor = confidenceColor(display.confidence);
  const confAlpha = confidenceBackgroundAlpha(display.confidence);
  const ringRadius = 16;
  const ringThickness = 5;
  const ringCx = 22;
  const ringCy = 118;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringProgress = confPercent !== null ? ringCircumference * (confPercent / 100) : 0;
  const maxLineLen = Math.max(line1.length, line2.length, line3.length);
  const lineCount = [line1, line2, line3].filter(Boolean).length || 1;
  const nameStroke = display.rare ? "rgba(255,200,80,0.9)" : "rgba(0,0,0,0.7)";
  const commonality = getCommonality(display.occurrence);
  const nameAreaHeight = pillY - 8;
  let nameFont = Math.min(30, Math.floor((nameAreaHeight - (lineCount - 1) * 6) / lineCount));
  if (maxLineLen > 12) {
    nameFont = Math.max(18, nameFont - (maxLineLen - 12) * 1.5);
  }
  if (lineCount === 1 && maxLineLen > 9) {
    nameFont = Math.max(18, nameFont - (maxLineLen - 9) * 2);
  }
  const maxTextWidth = width - 26;
  const widthFit = Math.floor(maxTextWidth / Math.max(1, maxLineLen * 0.62));
  if (Number.isFinite(widthFit)) {
    nameFont = Math.min(nameFont, widthFit);
  }
  nameFont = Math.max(16, nameFont);
  const totalNameHeight = lineCount * nameFont + (lineCount - 1) * 6;
  let startY = Math.floor((nameAreaHeight - totalNameHeight) / 2) + nameFont;
  if (startY < nameFont + 4) {
    startY = nameFont + 4;
  }
  const line1Y = startY;
  const line2Y = lineCount >= 2 ? startY + nameFont + 6 : startY;
  const line3Y = lineCount >= 3 ? startY + (nameFont + 6) * 2 : line2Y;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="transparent"/>`,
    renderCommonalityShape(commonality, 118, 118, 24),
    `<defs>`,
    `</defs>`,
    `<text x="72" y="${line1Y}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="${nameFont}" fill="#ffffff" stroke="${nameStroke}" stroke-width="3" paint-order="stroke">${line1}</text>`,
    `<text x="72" y="${line2Y}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="${nameFont}" fill="#ffffff" stroke="${nameStroke}" stroke-width="3" paint-order="stroke">${line2}</text>`,
    `<text x="72" y="${line3Y}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="${nameFont}" fill="#ffffff" stroke="${nameStroke}" stroke-width="3" paint-order="stroke">${line3}</text>`,
    `<circle cx="${ringCx}" cy="${ringCy}" r="${ringRadius}" fill="#101010"/>`,
    `<circle cx="${ringCx}" cy="${ringCy}" r="${ringRadius}" fill="none" stroke="#2a2a2a" stroke-width="${ringThickness}"/>`,
    `<circle cx="${ringCx}" cy="${ringCy}" r="${ringRadius}" fill="none" stroke="${confColor}" stroke-width="${ringThickness}" stroke-linecap="round" stroke-dasharray="${ringProgress} ${ringCircumference}" transform="rotate(-90 ${ringCx} ${ringCy})"/>`,
    `</svg>`
  ].join("");
}

function renderSvgBorder(display) {
  const width = 144;
  const height = 144;
  const statsFont = 16;
  const pillY = 104;

  const line1 = escapeXml(display.line1 || "");
  const line2 = escapeXml(display.line2 || "");
  const line3 = escapeXml(display.line3 || "");
  const confPercent = display.confidence !== null ? Math.round(display.confidence * 100) : null;
  const confColor = confidenceColor(display.confidence);
  const confColorDark = shadeColor(confColor, -35);
  const confAlpha = confidenceMeterAlpha(display.confidence);
  const maxLineLen = Math.max(line1.length, line2.length, line3.length);
  const lineCount = [line1, line2, line3].filter(Boolean).length || 1;
  const nameStroke = display.rare ? "rgba(255,200,80,0.9)" : "rgba(0,0,0,0.7)";
  const commonality = getCommonality(display.occurrence);
  const nameAreaHeight = pillY - 8;
  let nameFont = Math.min(30, Math.floor((nameAreaHeight - (lineCount - 1) * 6) / lineCount));
  if (maxLineLen > 12) {
    nameFont = Math.max(18, nameFont - (maxLineLen - 12) * 1.5);
  }
  if (lineCount === 1 && maxLineLen > 9) {
    nameFont = Math.max(18, nameFont - (maxLineLen - 9) * 2);
  }
  const maxTextWidth = width - 26;
  const widthFit = Math.floor(maxTextWidth / Math.max(1, maxLineLen * 0.62));
  if (Number.isFinite(widthFit)) {
    nameFont = Math.min(nameFont, widthFit);
  }
  nameFont = Math.max(16, nameFont);
  const totalNameHeight = lineCount * nameFont + (lineCount - 1) * 6;
  let startY = Math.floor((nameAreaHeight - totalNameHeight) / 2) + nameFont;
  if (startY < nameFont + 4) {
    startY = nameFont + 4;
  }
  const line1Y = startY;
  const line2Y = lineCount >= 2 ? startY + nameFont + 6 : startY;
  const line3Y = lineCount >= 3 ? startY + (nameFont + 6) * 2 : line2Y;

  const border = 6;
  const radius = 14;
  const path = [
    `M ${border + radius} ${border}`,
    `H ${width - border - radius}`,
    `A ${radius} ${radius} 0 0 1 ${width - border} ${border + radius}`,
    `V ${height - border - radius}`,
    `A ${radius} ${radius} 0 0 1 ${width - border - radius} ${height - border}`,
    `H ${border + radius}`,
    `A ${radius} ${radius} 0 0 1 ${border} ${height - border - radius}`,
    `V ${border + radius}`,
    `A ${radius} ${radius} 0 0 1 ${border + radius} ${border}`,
    "Z"
  ].join(" ");

  const progress = confPercent !== null ? confPercent : 0;
  const fillHeight = Math.round((height - border * 2) * (progress / 100));
  const fillY = height - border - fillHeight;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs>`,
    `<linearGradient id="meterFill" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0%" stop-color="${confColor}"/>`,
    `<stop offset="100%" stop-color="${confColorDark}"/>`,
    `</linearGradient>`,
    `<clipPath id="meterClip">`,
    `<rect x="${border}" y="${border}" width="${width - border * 2}" height="${height - border * 2}" rx="${radius}" ry="${radius}"/>`,
    `</clipPath>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="transparent"/>`,
    renderCommonalityShape(commonality, 118, 118, 24),
    `<rect x="${border}" y="${fillY}" width="${width - border * 2}" height="${fillHeight}" fill="url(#meterFill)" fill-opacity="${confAlpha}" clip-path="url(#meterClip)"/>`,
    `<path d="${path}" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="${border}" />`,
    `<text x="72" y="${line1Y}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="${nameFont}" fill="#ffffff" stroke="${nameStroke}" stroke-width="3" paint-order="stroke">${line1}</text>`,
    `<text x="72" y="${line2Y}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="${nameFont}" fill="#ffffff" stroke="${nameStroke}" stroke-width="3" paint-order="stroke">${line2}</text>`,
    `<text x="72" y="${line3Y}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="${nameFont}" fill="#ffffff" stroke="${nameStroke}" stroke-width="3" paint-order="stroke">${line3}</text>`,
    `</svg>`
  ].join("");
}

function renderSvgToday(display) {
  const width = 144;
  const height = 144;
  const pillY = 104;

  const line1 = escapeXml(display.line1 || "");
  const line2 = escapeXml(display.line2 || "");
  const line3 = escapeXml(display.line3 || "");
  const commonality = getCommonality(display.occurrence);
  const maxLineLen = Math.max(line1.length, line2.length, line3.length);
  const lineCount = [line1, line2, line3].filter(Boolean).length || 1;
  const nameStroke = display.rare ? "rgba(255,200,80,0.9)" : "rgba(0,0,0,0.7)";
  const nameAreaHeight = pillY - 6;
  let nameFont = Math.min(32, Math.floor((nameAreaHeight - (lineCount - 1) * 6) / lineCount));
  if (maxLineLen > 12) {
    nameFont = Math.max(18, nameFont - (maxLineLen - 12) * 1.5);
  }
  if (lineCount === 1 && maxLineLen > 9) {
    nameFont = Math.max(18, nameFont - (maxLineLen - 9) * 2);
  }
  const maxTextWidth = width - 26;
  const widthFit = Math.floor(maxTextWidth / Math.max(1, maxLineLen * 0.62));
  if (Number.isFinite(widthFit)) {
    nameFont = Math.min(nameFont, widthFit);
  }
  nameFont = Math.max(16, nameFont);
  const totalNameHeight = lineCount * nameFont + (lineCount - 1) * 6;
  let startY = Math.floor((nameAreaHeight - totalNameHeight) / 2) + nameFont;
  if (startY < nameFont + 4) {
    startY = nameFont + 4;
  }
  const line1Y = startY;
  const line2Y = lineCount >= 2 ? startY + nameFont + 6 : startY;
  const line3Y = lineCount >= 3 ? startY + (nameFont + 6) * 2 : line2Y;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="transparent"/>`,
    `<text x="72" y="${line1Y}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="${nameFont}" fill="#ffffff" stroke="${nameStroke}" stroke-width="3" paint-order="stroke">${line1}</text>`,
    `<text x="72" y="${line2Y}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="${nameFont}" fill="#ffffff" stroke="${nameStroke}" stroke-width="3" paint-order="stroke">${line2}</text>`,
    `<text x="72" y="${line3Y}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="${nameFont}" fill="#ffffff" stroke="${nameStroke}" stroke-width="3" paint-order="stroke">${line3}</text>`,
    renderCommonalityShape(commonality, 118, 118, 24),
    `</svg>`
  ].join("");
}

function splitName(text, maxLen, maxLines) {
  if (!text) {
    return [];
  }

  const words = text.split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = (current + " " + word).trim();
    if (next.length <= maxLen) {
      current = next;
    } else {
      if (current) {
        lines.push(current);
        current = word.length <= maxLen ? word : truncateToFit(word, maxLen);
      } else {
        lines.push(truncateToFit(word, maxLen));
        current = "";
      }
    }

    if (lines.length === maxLines) {
      break;
    }
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    return lines.slice(0, maxLines);
  }

  if (lines.length === maxLines && words.length > 0) {
    const allText = lines.join(" ");
    if (allText.length < text.length) {
      lines[maxLines - 1] = truncateToFit(lines[maxLines - 1], maxLen);
    }
  }

  return lines;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function confidenceColor(confidence) {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return "#666666";
  }
  const clamped = Math.max(0, Math.min(1, confidence));
  const hue = clamped * 120; // 0 = red, 120 = green
  return hslToHex(hue, 85, 45);
}

function hslToHex(h, s, l) {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c; g = x; b = 0;
  } else if (h < 120) {
    r = x; g = c; b = 0;
  } else if (h < 180) {
    r = 0; g = c; b = x;
  } else if (h < 240) {
    r = 0; g = x; b = c;
  } else if (h < 300) {
    r = x; g = 0; b = c;
  } else {
    r = c; g = 0; b = x;
  }
  const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function shadeColor(hex, percent) {
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  const amt = Math.round(2.55 * percent);
  const r = Math.max(0, Math.min(255, (num >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0x00ff) + amt));
  const b = Math.max(0, Math.min(255, (num & 0x0000ff) + amt));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function confidenceBackgroundAlpha(confidence) {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(1, confidence));
  return 0.06 + clamped * 0.12;
}

function confidenceMeterAlpha(confidence) {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return 0.12;
  }
  const clamped = Math.max(0, Math.min(1, confidence));
  return 0.18 + clamped * 0.35;
}

function recordDetection() {
  const now = Date.now();
  detectionTimestamps.push(now);
  pruneDetections(now);
}

function pruneDetections(now) {
  const cutoff = now - 60 * 60 * 1000;
  while (detectionTimestamps.length > 0 && detectionTimestamps[0] < cutoff) {
    detectionTimestamps.shift();
  }
}

function getDetectionsLastHour() {
  const now = Date.now();
  pruneDetections(now);
  return detectionTimestamps.length;
}

function formatCount(count) {
  if (!count || count <= 0) {
    return "";
  }
  if (count > 9) {
    return "9+";
  }
  return String(count);
}

function formatOccurrence(occurrence, fallbackCount) {
  if (typeof occurrence === "number" && !Number.isNaN(occurrence)) {
    return `${Math.round(occurrence * 100)}%`;
  }
  if (typeof fallbackCount === "number" && fallbackCount > 0) {
    return String(fallbackCount);
  }
  return "";
}

function getCommonality(occurrence) {
  if (typeof occurrence !== "number" || Number.isNaN(occurrence)) {
    return { label: "Unknown", color: "#9ca3af", shape: "hex" };
  }

  const epic = Number.isFinite(Number(settings.epicOccurrenceThreshold))
    ? Number(settings.epicOccurrenceThreshold)
    : DEFAULTS.epicOccurrenceThreshold;
  const rare = Number.isFinite(Number(settings.rareOccurrenceThreshold))
    ? Number(settings.rareOccurrenceThreshold)
    : DEFAULTS.rareOccurrenceThreshold;
  const uncommon = Number.isFinite(Number(settings.uncommonOccurrenceThreshold))
    ? Number(settings.uncommonOccurrenceThreshold)
    : DEFAULTS.uncommonOccurrenceThreshold;

  const epicCutoff = Math.max(0, Math.min(1, epic));
  const rareCutoff = Math.max(epicCutoff, Math.min(1, rare));
  const uncommonCutoff = Math.max(rareCutoff, Math.min(1, uncommon));

  if (occurrence <= epicCutoff) {
    return { label: "Epic", color: "#7c3aed", shape: "star" };
  }
  if (occurrence <= rareCutoff) {
    return { label: "Rare", color: "#f59e0b", shape: "diamond" };
  }
  if (occurrence <= uncommonCutoff) {
    return { label: "Uncommon", color: "#38bdf8", shape: "square" };
  }
  return { label: "Common", color: "#22c55e", shape: "circle" };
}

function updateDailyBirds(detection) {
  const dateKey = detection.detectionDate || new Date().toISOString().slice(0, 10);
  if (!dailyBirds.has(dateKey)) {
    dailyBirds.set(dateKey, new Map());
  }
  const dayMap = dailyBirds.get(dateKey);
  const key = detection.name;
  if (!key) {
    return;
  }
  const existing = dayMap.get(key) || {};
  const occurrence = typeof detection.occurrence === "number" ? detection.occurrence : existing.occurrence;
  const confidence = typeof detection.confidence === "number" ? detection.confidence : existing.confidence;
  const record = {
    name: detection.name,
    occurrence: typeof occurrence === "number" ? Math.min(occurrence, existing.occurrence ?? occurrence) : occurrence,
    confidence,
    lastSeen: Date.now()
  };
  dayMap.set(key, record);
  pruneOldDays(dateKey);
  scheduleCacheSave();
}

function pruneOldDays(todayKey) {
  for (const key of dailyBirds.keys()) {
    if (key !== todayKey) {
      dailyBirds.delete(key);
    }
  }
}

function getTodayBirds() {
  const todayKey = new Date().toISOString().slice(0, 10);
  const dayMap = dailyBirds.get(todayKey);
  if (!dayMap) {
    return [];
  }
  return Array.from(dayMap.values()).sort((a, b) => {
    const occA = typeof a.occurrence === "number" ? a.occurrence : 1;
    const occB = typeof b.occurrence === "number" ? b.occurrence : 1;
    return occA - occB;
  });
}

function startRotation(context, immediate) {
  if (!context) {
    return;
  }
  if (!rotationState.has(context)) {
    rotationState.set(context, { index: 0, timer: null });
  }
  const state = rotationState.get(context);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (immediate) {
    rotateOnce(context);
  } else {
    state.timer = setTimeout(() => rotateOnce(context), 50);
  }
}

function stopRotation(context) {
  const state = rotationState.get(context);
  if (state && state.timer) {
    clearTimeout(state.timer);
  }
  rotationState.delete(context);
}

function rotateOnce(context) {
  const state = rotationState.get(context);
  if (!state) {
    return;
  }

  const birds = getTodayBirds();
  if (!birds.length) {
    setTitle(context, "Waiting\n...");
    state._lastRareHold = false;
  } else {
    if (state.index >= birds.length) {
      state.index = 0;
    }
    const bird = birds[state.index];
    state.index += 1;

    const display = formatTitle(bird.name, bird.confidence, getDetectionsLastHour(), bird.occurrence);
    setImageTitle(context, display, "today");

    const threshold = Number(settings.rareOccurrenceThreshold) || DEFAULTS.rareOccurrenceThreshold;
    state._lastRareHold = typeof bird.occurrence === "number" && bird.occurrence <= threshold;
  }

  const seconds = Number(settings.rotationSeconds) || DEFAULTS.rotationSeconds;
  const holdMultiplier = Number(settings.rareHoldMultiplier) || DEFAULTS.rareHoldMultiplier;
  const delayMs = Math.max(1, seconds * 1000 * (state._lastRareHold ? holdMultiplier : 1));

  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => rotateOnce(context), delayMs);
}

function saveSettings() {
  if (!websocket || !actionContext) {
    logLine("saveSettings skipped (no websocket/context)");
    return;
  }

  websocket.send(JSON.stringify({
    event: "setSettings",
    context: actionContext,
    payload: settings
  }));
  logLine(`setSettings sent ${JSON.stringify(settings)}`);
}

function sendToPropertyInspector() {
  if (!websocket || !actionContext) {
    return;
  }

  websocket.send(JSON.stringify({
    event: "sendToPropertyInspector",
    context: actionContext,
    payload: {
      settings: { ...globalSettings, ...settings }
    }
  }));
}

global.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
module.exports = {
  connectElgatoStreamDeckSocket
};

if (process && Array.isArray(process.argv)) {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length - 1; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (key && key.startsWith("-")) {
      parsed[key] = value;
    }
  }

  const port = parsed["-port"];
  const pluginUUID = parsed["-pluginUUID"];
  const registerEvent = parsed["-registerEvent"];
  const info = parsed["-info"];
  const actionInfo = parsed["-actionInfo"];

  if (port && pluginUUID && registerEvent) {
    logLine(`boot argv port=${port} uuid=${pluginUUID} event=${registerEvent}`);
    connectElgatoStreamDeckSocket(port, pluginUUID, registerEvent, info, actionInfo);
  } else {
    logLine(`boot argv missing args ${JSON.stringify(parsed)}`);
  }
}
