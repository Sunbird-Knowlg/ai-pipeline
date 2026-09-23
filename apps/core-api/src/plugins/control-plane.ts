import fp from 'fastify-plugin';
import type { ControlPlane } from '../domain/deps.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The control plane's collaborators. Routes call domain functions with it; they hold no state. */
    controlPlane: ControlPlane;
  }
}

/**
 * Makes the control-plane collaborators available to every route as `fastify.controlPlane`.
 *
 * Wrapped in `fastify-plugin` so the decorator escapes this plugin's encapsulation context and the
 * route plugins registered alongside it can see it.
 */
export const controlPlanePlugin = fp(
  async (app, controlPlane: ControlPlane) => {
    app.decorate('controlPlane', controlPlane);
  },
  { name: 'control-plane' },
);
