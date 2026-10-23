import { Rws1WriteAdapter } from "./rws1-write-adapter.mjs";

/**
 * RobotWare 7 / RWS 2.0 write descriptors. The shared implementation keeps
 * every safety exclusion and input validator identical across protocols while
 * selecting only paths and status codes declared by ABB's RWS2 OpenAPI.
 */
export class Rws2WriteAdapter extends Rws1WriteAdapter {
  constructor() {
    super({ protocol: "rws2" });
  }

  descriptor(options) {
    if (["rapidLoadModuleReplace", "rapidBuild", "rapidBuildErrors", "fileDelete"].includes(options.operation)) {
      return super.descriptor({ ...options,
        request: { ...options.request, accept: "application/xhtml+xml;v=2.0" }
      });
    }
    return super.descriptor(options);
  }
}

export default Rws2WriteAdapter;
