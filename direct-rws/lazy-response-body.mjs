function attachLazyUtf8Body(response, bytes) {
  let decoded = false;
  let body;
  Object.defineProperty(response, "body", {
    configurable: true,
    enumerable: true,
    get() {
      if (!decoded) {
        body = bytes.toString("utf8");
        decoded = true;
      }
      return body;
    },
    set(value) {
      body = value;
      decoded = true;
    }
  });
  return response;
}

export { attachLazyUtf8Body };
