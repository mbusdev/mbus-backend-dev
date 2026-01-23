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
    "WX": { color: "#E8663E", image: "bus_WX.png" },
    // the ride
    "3": {color: "#0B9D57", image: "3.png" },
    "4": {color: "#9D3E97", image: "4.png" },
    "5": {color: "#086CB6", image: "5.png" },
    "6": {color: "#F58220", image: "6.png" },
    "22": {color: "#F5B94E", image: "22.png" },
    "23": {color: "#086CB6", image: "23.png" },
    "25": {color: "#0B9D57", image: "25.png" },
    "26": {color: "#086CB6", image: "26.png" },
    "27": {color: "#F5B94E", image: "27.png" },
    "28": {color: "#F58220", image: "28.png" },
    "29": {color: "#086CB6", image: "29.png" },
    "30": {color: "#9D3E97", image: "30.png" },
    "31": {color: "#0B9D57", image: "31.png" },
    "32": {color: "#A36D30", image: "32.png" },
    "33": {color: "#086CB6", image: "33.png" },
    "34": {color: "#D7242A", image: "34.png" },
    "42": {color: "#D7242A", image: "42.png" },
    "43": {color: "#F58220", image: "43.png" },
    "44": {color: "#75BA44", image: "44.png" },
    "45": {color: "#F5B94E", image: "45.png" },
    "46": {color: "#A36D30", image: "46.png" },
    "47": {color: "#0B9D57", image: "47.png" },
    "61": {color: "#F5B94E", image: "61.png" },
    "62": {color: "#A36D30", image: "62.png" },
    "63": {color: "#F58220", image: "63.png" },
    "64": {color: "#D7242A", image: "64.png" },
    "65": {color: "#75BA44", image: "65.png" },
    "66": {color: "#A36D30", image: "66.png" },
    "67": {color: "#F5B94E", image: "67.png" },
    "68": {color: "#D7242A", image: "68.png" },
    "104": {color: "#9D3E97", image: "104.png" }
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