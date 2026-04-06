// @ts-check

/** @type {string[]} */
const types = [
	'pedestrian', 'footway', 'path', 'steps',
	'living_street', 'residential', 'service',
	'track', 'corridor', 'crossing', 'cycleway',
	'bridleway', 'unclassified'
];

/** @type {string[]} */
const colors = [
	'red', 'aquamarine', 'blue', 'hotpink',
	'maroon', 'yellowgreen', 'slateblue',
	'indigo', 'goldenrod', 'chocolate', 'black',
	'red', 'lightsteelblue'
];

const legend = /** @type {HTMLElement} */ (document.getElementById('legend'));
for (let i = 0; i < types.length; i++) {
	const p = legend.appendChild(document.createElement('p'));
	p.textContent = `${types[i] ?? ''}: ${colors[i] ?? ''}`;
	p.style.color = colors[i] ?? '';
}

/** @type {google.maps.LatLng | null} */
let start = null;
/** @type {google.maps.LatLng | null} */
let end = null;
/** @type {google.maps.marker.AdvancedMarkerElement[]} */
let markers = [];
/** @type {google.maps.Polyline[]} */
let polylines = [];

async function initMap() {
	console.log("hi");
	const [{Polyline}, {AdvancedMarkerElement, PinElement}, {SymbolPath}] = await Promise.all([
		google.maps.importLibrary("maps"), google.maps.importLibrary("marker"), google.maps.importLibrary('core')
	]);
	const map = new google.maps.Map(
		/** @type {HTMLElement} */ (document.getElementById("map")),
		{center: {lat: 42.2830, lng: -83.7350}, zoom: 14, mapId: "DEMO_MAP_ID"}
	);

	const updateMap = (
		/** @type {Array<{lat: number, lon: number, prevEdgeTypes?: string[], [key: string]: any}>} */ nodes,
		/** @type {Array<{lat: number, lon: number, [key: string]: any}>} */ detailedPath,
	) => {
		// remove existing markers and polylines
		markers.map((m) => {m.map = null;})
		markers = [];
		polylines.map((p) => {p.setMap(null);})
		polylines = [];

		// graph nodes
		if (nodes.length > 0) {
			const locations = nodes.map((x) => {return {...x, lng: x.lon}});
			let prevLoc = null;
			for (const l of locations) {
				markers.push(new AdvancedMarkerElement({
					map,
					position: l,
					content: new PinElement({scale: 0.3, glyphColor: "magenta", borderColor: "magenta", background: "magenta"}),
				}));
				if (prevLoc) {
					let color = [];
					if (l.prevEdgeTypes) {
						for (let i = 0; i < types.length; i++) {
							if (l.prevEdgeTypes.includes(types[i] ?? '')) {
								color.push(colors[i] ?? 'grey');
							}
						}
					}
					if (color.length == 0) {
						color = ["grey"];
					}
					if (color.length > 1) {
						console.log(color);
					}
					const line = new Polyline({
						map,
						zIndex: 0,
						path: [prevLoc, l],
						strokeWeight: 4,
						icons: color.map((c, i) => {
							return {
								icon: {path: SymbolPath.CIRCLE, fillColor: c ?? null, strokeColor: c ?? null, fillOpacity: 1},
								repeat: `${10 * color.length}px`,
								offset: `${10 * i}px`
							};
						})
					});
					line.addListener("click", () => {
						window.alert(JSON.stringify(l));
					});
					polylines.push(line);
				}
				prevLoc = l;
			}
		}

		// detailed walking path
		if (detailedPath.length > 0) {
			const locations = detailedPath.map((x) => {return {lat: x.lat, lng: x.lon}});
			for (const l of locations) {
				markers.push(new AdvancedMarkerElement({
					map,
					zIndex: 1,
					position: l,
					content: new PinElement({scale: 0.2, glyphColor: "orange", borderColor: "orange", background: "orange"}),
				}));
			}
			polylines.push(new Polyline({map, zIndex: 1, path: locations, strokeColor: "orange", clickable: false}));
		}

		if (start) {
			markers.push(new AdvancedMarkerElement({
				map, position: start, title: "start"
			}));
		}

		if (end) {
			markers.push(new AdvancedMarkerElement({
				map,
				position: end,
				title: "end",
				content: new PinElement({glyphColor: "darkgreen", borderColor: "green", background: "green"}),
			}));
		}
	};

	const update = () => {
		if (start && end) {
			console.log(start.lat());
			const req = new Request(
				`../mbus/api/v3/plan-journey?`
				+ `originLat=${start.lat()}&originLon=${start.lng()}&destLat=${end.lat()}&destLon=${end.lng()}`
			);
			fetch(req).then((res) => {
				res.json().then((body) => {
					console.log(body);
					const leg = body.journeys[0].legs[0];
					console.log(leg);
					updateMap(leg.node_coords, leg.path_coords);
				});
			});
		} else {
			updateMap([], []);
		}
	};

	map.addListener("click", (/** @type {google.maps.MapMouseEvent} */ e) => {
		console.log(`click: ${JSON.stringify(e)}`);
		start = e.latLng;
		update();
	});

	map.addListener("contextmenu", (/** @type {google.maps.MapMouseEvent} */ e) => {
		console.log(`contextmenu: ${JSON.stringify(e)}`);
		end = e.latLng;
		update();
	});
}

initMap();
