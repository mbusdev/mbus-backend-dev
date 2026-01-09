import * as metadataRaw from "../assets/route-data.json";

const metadata = metadataRaw as any;

const ROUTE_CONFIG: Record<string, { color: string, image: string }> = {
    "BB": { color: "#2F773F", image: "bus_BB.png" },
    "CN": { color: "#643076", image: "bus_CN.png" },
    "CS": { color: "#3559B8", image: "bus_CS.png" },
    "CSX": { color: "#1C2256", image: "bus_CSX.png" },
    "DD": { color: "#A9C534", image: "bus_DD.png" },
    "MX": { color: "#5EC7DE", image: "bus_MX.png" },
    "NE": { color: "#C55188", image: "bus_NE.png" },
    "NW": { color: "#AE3636", image: "bus_NW.png" },
    "NX": { color: "#DA4343", image: "bus_NX.png" },
    "OS": { color: "#E8A43C", image: "bus_OS.png" },
    "NES": { color: "#C55188", image: "bus_NES.png" },
    "WS": { color: "#BA5231", image: "bus_WS.png" },
    "WX": { color: "#E8663E", image: "bus_WX.png" }
};

/** Gets the color for a specific route ID. */
export function getRouteColor(routeId: string) {
    return ROUTE_CONFIG[routeId]?.color || null;
}

/** Gets the image filename for a specific route ID. */
export function getRouteImage(routeId: string) {
    return ROUTE_CONFIG[routeId]?.image || null;
}

/** Returns configuration for all routes. */
export function getAllRouteConfig() {
    return Object.entries(ROUTE_CONFIG).map(([id, config]) => ({
        routeId: id,
        ...config
    }));
}

/** Raw static metadata from JSON. */
export const staticData = metadata;