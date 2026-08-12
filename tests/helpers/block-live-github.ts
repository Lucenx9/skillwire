if (process.env["SKILLWIRE_BLOCK_GITHUB_NETWORK"] !== "false") {
  const systemFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.protocol === "https:" && url.hostname === "api.github.com") {
      return Promise.reject(new Error("UNEXPECTED_LIVE_GITHUB_REQUEST"));
    }
    return systemFetch(input, init);
  };
}
