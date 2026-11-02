import api from '../apps/api/src/index.js';

export async function onRequest({ request, env }) {
  return api.fetch(request, env);
}
