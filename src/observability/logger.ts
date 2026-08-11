import pino, { type DestinationStream, type Logger } from "pino";

import type { SecurityEventFields, SecurityEventName } from "./audit-events.js";
import { securityEvent } from "./audit-events.js";
import { redactSensitive } from "./redaction.js";

export interface SecurityLogger {
  emit(event: SecurityEventName, fields?: SecurityEventFields): void;
}

export function createSecurityLogger(
  destination?: DestinationStream,
  level = "info",
): SecurityLogger {
  const logger: Logger = pino(
    {
      base: null,
      level,
      messageKey: "message",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
  return {
    emit(event, fields) {
      const redacted = redactSensitive(securityEvent(event, fields));
      logger.info(redacted);
    },
  };
}

export const silentSecurityLogger: SecurityLogger = Object.freeze({
  emit: () => undefined,
});
