/**
 * Logging utility for MCP server
 *
 * Provides centralized logging to both console and file
 */

import winston from "winston";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let logger: winston.Logger | null = null;

/**
 * Initialize logger with config
 */
export function initLogger(config?: { level?: string; file?: string }): void {
  const logLevel = config?.level || "info";
  const logFile = config?.file || "logs/mcp-server.log";

  // Resolve log file path relative to project root (one level up from src)
  const projectRoot = path.resolve(__dirname, "..");
  const logPath = path.resolve(projectRoot, logFile);
  const logDir = path.dirname(logPath);

  // Create log directory if it doesn't exist
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Create Winston logger
  logger = winston.createLogger({
    level: logLevel,
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let msg = `${timestamp} [${level.toUpperCase()}] ${message}`;
        if (Object.keys(meta).length > 0) {
          msg += ` ${JSON.stringify(meta)}`;
        }
        return msg;
      })
    ),
    transports: [
      // Write to file
      new winston.transports.File({
        filename: logPath,
        maxsize: 10485760, // 10MB
        maxFiles: 5,
      }),
      // Also write to stderr (for MCP protocol - goes to Claude's logs)
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        ),
        stderrLevels: ["error", "warn", "info", "debug"],
      }),
    ],
  });

  logger.info(`Logger initialized: ${logPath}`);
}

/**
 * Log info message
 */
export function logInfo(message: string, ...args: any[]): void {
  if (!logger) {
    console.error(`[INFO] ${message}`, ...args);
    return;
  }
  logger.info(message, ...args);
}

/**
 * Log error message
 */
export function logError(message: string, ...args: any[]): void {
  if (!logger) {
    console.error(`[ERROR] ${message}`, ...args);
    return;
  }
  logger.error(message, ...args);
}

/**
 * Log warning message
 */
export function logWarn(message: string, ...args: any[]): void {
  if (!logger) {
    console.error(`[WARN] ${message}`, ...args);
    return;
  }
  logger.warn(message, ...args);
}

/**
 * Log debug message
 */
export function logDebug(message: string, ...args: any[]): void {
  if (!logger) {
    console.error(`[DEBUG] ${message}`, ...args);
    return;
  }
  logger.debug(message, ...args);
}

/**
 * Get the logger instance (for advanced usage)
 */
export function getLogger(): winston.Logger | null {
  return logger;
}
