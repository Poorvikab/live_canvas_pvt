(function () {
    const LOCAL_BACKEND_URL = "http://localhost:3000";
    const PRODUCTION_BACKEND_URL = "https://live-canvas-pvt.onrender.com";
    const currentHost = window.location.hostname;
    const configuredBackendUrl = (
        window.__BACKEND_URL__ ||
        window.__LIVE_CANVAS_BACKEND_URL__ ||
        ""
    ).replace(/\/$/, "");

    const resolvedBackendUrl = configuredBackendUrl || (
        currentHost === "localhost" || currentHost === "127.0.0.1"
            ? LOCAL_BACKEND_URL
            : PRODUCTION_BACKEND_URL
    );

    window.LIVE_CANVAS_CONFIG = {
        BACKEND_URL: resolvedBackendUrl,
        IS_LOCAL: currentHost === "localhost" || currentHost === "127.0.0.1",
        apiUrl(path) {
            const normalizedPath = path.startsWith("/") ? path : `/${path}`;
            return `${this.BACKEND_URL}${normalizedPath}`;
        }
    };
})();
