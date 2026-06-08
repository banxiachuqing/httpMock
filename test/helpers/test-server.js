import supertest from 'supertest';
import { createApi } from '../../src/api.js';

export function buildApp({ storagePath, configStore, logBuffer, mockEngine }) {
  const app = createApi({ storagePath, configStore, logBuffer, mockEngine });
  return { app, request: supertest(app) };
}
