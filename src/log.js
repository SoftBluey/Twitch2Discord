"use strict";

function createLogger(token = "") {
  function redact(value) {
    let message = String(value?.message || value);
    if (token) message = message.split(token).join("[redacted]");
    return message.replace(/https?:\/\/[^\s'"<>]+/gi, "[URL redacted]");
  }
  return {
    info: (value) => console.log(redact(value)),
    warn: (value) => console.warn(redact(value)),
    error: (value) => console.error(redact(value)),
  };
}

module.exports = { createLogger };
