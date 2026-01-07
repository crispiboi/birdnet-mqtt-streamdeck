/* global WebSocket */

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
  rareHoldMultiplier: 2,
  debugLogging: false
};

let websocket = null;
let uuid = null;
let actionContext = null;
let actionUUID = null;
let pendingSettings = null;
let isSocketOpen = false;
let globalSettings = { ...DEFAULTS };

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
    // continue
  }
  try {
    return JSON.parse(decodeURIComponent(inActionInfo));
  } catch (err) {
    // continue
  }
  try {
    return JSON.parse(atob(inActionInfo));
  } catch (err) {
    return null;
  }
}

function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, _inInfo, inActionInfo) {
  uuid = inUUID;
  const actionInfo = parseActionInfo(inActionInfo);
  actionContext = actionInfo && actionInfo.context ? actionInfo.context : actionContext;
  actionUUID = actionInfo && actionInfo.action ? actionInfo.action : actionUUID;
  if (actionInfo && actionInfo.payload && actionInfo.payload.settings) {
    const settings = { ...DEFAULTS, ...(actionInfo.payload.settings || {}) };
    lastReceivedSettings = settings;
    updateForm(settings);
  }
  websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);

  websocket.onopen = () => {
    isSocketOpen = true;
    const register = {
      event: inRegisterEvent,
      uuid: inUUID
    };
    websocket.send(JSON.stringify(register));

    websocket.send(JSON.stringify({
      event: "getSettings",
      context: uuid
    }));

    websocket.send(JSON.stringify({
      event: "getGlobalSettings",
      context: uuid
    }));

    if (pendingSettings) {
      sendSettings();
    }
    updateDebug();
  };

  websocket.onclose = () => {
    isSocketOpen = false;
    updateDebug();
  };

  websocket.onerror = () => {
    updateDebug();
  };

  websocket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    lastEvent = message.event;
    if (message.context) {
      actionContext = message.context;
    }

    if (message.event === "didReceiveSettings") {
      const settings = { ...DEFAULTS, ...globalSettings, ...(message.payload.settings || {}) };
      updateForm(settings);
    }

    if (message.event === "sendToPropertyInspector") {
      const settings = { ...DEFAULTS, ...globalSettings, ...(message.payload.settings || {}) };
      updateForm(settings);
    }

    if (message.event === "didReceiveGlobalSettings") {
      globalSettings = { ...DEFAULTS, ...(message.payload.settings || {}) };
      updateForm(globalSettings);
    }
  };
}

function updateForm(settings) {
  setValue("mqttHost", settings.mqttHost);
  setValue("mqttPort", settings.mqttPort);
  setValue("mqttTopic", settings.mqttTopic);
  setValue("mqttClientId", settings.mqttClientId);
  setValue("mqttUsername", settings.mqttUsername);
  setValue("mqttPassword", settings.mqttPassword);
  setChecked("mqttTls", settings.mqttTls);
  setValue("payloadKey", settings.payloadKey);
  setValue("rotationSeconds", settings.rotationSeconds);
  setValue("epicOccurrenceThreshold", settings.epicOccurrenceThreshold);
  setValue("rareOccurrenceThreshold", settings.rareOccurrenceThreshold);
  setValue("uncommonOccurrenceThreshold", settings.uncommonOccurrenceThreshold);
  setValue("rareHoldMultiplier", settings.rareHoldMultiplier);
  setChecked("debugLogging", settings.debugLogging);
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.value = value ?? "";
  }
}

function setChecked(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.checked = Boolean(value);
  }
}

function gatherSettings() {
  return {
    mqttHost: document.getElementById("mqttHost").value.trim(),
    mqttPort: Number(document.getElementById("mqttPort").value) || DEFAULTS.mqttPort,
    mqttTopic: document.getElementById("mqttTopic").value.trim(),
    mqttClientId: document.getElementById("mqttClientId").value.trim(),
    mqttUsername: document.getElementById("mqttUsername").value.trim(),
    mqttPassword: document.getElementById("mqttPassword").value,
    mqttTls: document.getElementById("mqttTls").checked,
    payloadKey: document.getElementById("payloadKey").value.trim(),
    rotationSeconds: Number(document.getElementById("rotationSeconds").value) || DEFAULTS.rotationSeconds,
    epicOccurrenceThreshold: Number(document.getElementById("epicOccurrenceThreshold").value) || DEFAULTS.epicOccurrenceThreshold,
    rareOccurrenceThreshold: Number(document.getElementById("rareOccurrenceThreshold").value) || DEFAULTS.rareOccurrenceThreshold,
    uncommonOccurrenceThreshold: Number(document.getElementById("uncommonOccurrenceThreshold").value) || DEFAULTS.uncommonOccurrenceThreshold,
    rareHoldMultiplier: Number(document.getElementById("rareHoldMultiplier").value) || DEFAULTS.rareHoldMultiplier,
    debugLogging: document.getElementById("debugLogging").checked
  };
}

function sendSettings() {
  if (!websocket || !uuid) {
    return;
  }

  const settings = gatherSettings();
  pendingSettings = settings;

  if (!isSocketOpen || websocket.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    websocket.send(JSON.stringify({
      event: "setSettings",
      context: uuid,
      action: actionUUID,
      payload: settings
    }));
    websocket.send(JSON.stringify({
      event: "setGlobalSettings",
      context: uuid,
      payload: settings
    }));
    pendingSettings = null;
  } catch (err) {
    // ignore
  }
}

function bindInputs() {
  const ids = [
    "mqttHost",
    "mqttPort",
    "mqttTopic",
    "mqttClientId",
    "mqttUsername",
    "mqttPassword",
    "mqttTls",
    "payloadKey",
    "rotationSeconds",
    "epicOccurrenceThreshold",
    "rareOccurrenceThreshold",
    "uncommonOccurrenceThreshold",
    "rareHoldMultiplier",
    "debugLogging"
  ];

  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) {
      return;
    }

    const eventName = el.type === "checkbox" ? "change" : "input";
    el.addEventListener(eventName, () => {
      sendSettings();
    });
  });

}

document.addEventListener("DOMContentLoaded", () => {
  bindInputs();
});

window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
