import { IMAGE_AI_UNCONFIGURED_MESSAGE } from "./image-generation-config.mjs";

export class UnconfiguredImageGenerationProvider {
  constructor(config = {}) {
    this.name = config.provider || null;
    this.model = config.model || null;
    this.configured = false;
  }

  async generate() {
    throw Object.assign(new Error(IMAGE_AI_UNCONFIGURED_MESSAGE), { code: "IMAGE_AI_NOT_CONFIGURED", status: 409 });
  }
}
export function createImageGenerationProvider(config) {
  // A concrete provider is intentionally not selected until its API contract is approved.
  return new UnconfiguredImageGenerationProvider(config);
}
