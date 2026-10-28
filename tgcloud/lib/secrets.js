import * as env from './env.js';
import { SecretRepo } from './repositories.js';
import { AppError } from './errors.js';

// env.js (written by CI) wins; the `secrets` table is the fallback.
export class Secrets {
  static env(name) { return env[name] || null; }

  static async get(name) { return Secrets.env(name) ?? (await SecretRepo.get(name)); }

  static async require(name) {
    const value = await Secrets.get(name);
    if (!value) throw new AppError('NO_SECRET', `${name} is not set in env.js or the secrets table.`);
    return value;
  }

  static set(name, value) { return SecretRepo.set(name, value); }
}
