function createRedisClient({ url, token }) {
  const baseUrl = String(url || "").trim().replace(/\/$/, "");
  const authToken = String(token || "").trim();

  async function command(name, args = []) {
    const encodedArgs = args.map((arg) => encodeURIComponent(String(arg)));
    const path = [name, ...encodedArgs].join("/");
    const requestUrl = `${baseUrl}/${path}`;

    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`
      }
    });

    if (!response.ok) {
      let details = "";
      try {
        const payload = await response.json();
        details = payload?.error ? ` - ${payload.error}` : "";
      } catch (_error) {
        details = "";
      }
      const error = new Error(`Redis request failed: ${response.status}${details}`);
      error.status = response.status;
      error.requestUrl = requestUrl;
      throw error;
    }

    const payload = await response.json();
    if (payload?.error) {
      throw new Error(payload.error);
    }

    return payload?.result;
  }

  return { command };
}

module.exports = { createRedisClient };
