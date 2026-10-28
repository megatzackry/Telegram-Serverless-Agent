import { BotApiError } from 'sdk';
import { ErrorLogRepo } from './repositories.js';

export class AppError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code ?? 'UNKNOWN';
    this.details = details;
  }

  // Normalizes anything thrown (AppError, BotApiError, plain Error) into an AppError.
  static from(err) {
    if (err instanceof AppError) return err;
    if (err instanceof BotApiError) {
      return new AppError(`BOT_API_${err.code}`, err.description, { method: err.method, parameters: err.parameters });
    }
    return new AppError('UNHANDLED_EXCEPTION', err?.message || 'Unknown error', err?.stack);
  }

  // Logs to error_logs and returns the normalized error. Never throws.
  static async handle(err, payload) {
    const error = AppError.from(err);
    try {
      await ErrorLogRepo.add({ code: error.code, message: error.message, details: error.details, payload });
    } catch (logErr) {
      console.error('error_logs write failed', logErr, error);
    }
    return error;
  }
}

// Replaces the try/catch in GAS doPost: a handler that throws is logged, not surfaced to Telegram.
export const guarded = (handler) => async (payload, ctx) => {
  try {
    return await handler(payload, ctx);
  } catch (err) {
    await AppError.handle(err, payload);
  }
};
