# Indoor Navigation API Documentation

##  Overview

This API provides indoor navigation within a building using a graph-based model.

* Each **node** represents a location (corridor, door, stair, elevator)
* Each **edge** represents a connection between two nodes
* The system computes the **shortest path** between two nodes

The graph data is loaded from `.graph.json` files and processed by the backend.

---

##  Data Model

### Node Types

| Type     | Description         |
| -------- | ------------------- |
| corridor | Hallway point       |
| door     | Room entrance       |
| stair    | Stair connection    |
| elevator | Elevator connection |

---

### Edge Types

| Type     | Description         |
| -------- | ------------------- |
| walk     | Normal walking path |
| stairs   | Stair connection    |
| elevator | Elevator connection |

---

##  Request

### Endpoint

POST /indoor/route

---

### Request Body

```json
{
  "buildingId": "dc",
  "floor": 1,
  "startNodeId": "dc_f1_corridor_001",
  "endNodeId": "dc_f1_1317_door"
}
```

---

### Field Explanation

| Field       | Type   | Required | Description         |
| ----------- | ------ | -------- | ------------------- |
| buildingId  | string | ✅        | Building identifier |
| floor       | number | ✅        | Floor number        |
| startNodeId | string | ✅        | Starting node ID    |
| endNodeId   | string | ✅        | Destination node ID |

---

## 📤 Response

### Success Response

```json
{
  "path": [
    "dc_f1_corridor_001",
    "dc_f1_corridor_002",
    "dc_f1_corridor_003",
    "dc_f1_1317_door"
  ],
  "totalDistance": 12.5
}
```

---

### Field Explanation

| Field         | Type   | Description                                    |
| ------------- | ------ | ---------------------------------------------- |
| path          | array  | Ordered list of node IDs representing the path |
| totalDistance | number | Total path distance                            |

---

### Error Response

```json
{
  "error": "Invalid node ID"
}
```

---

##  How It Works

1. Client sends a request with start and end node IDs
2. Backend loads graph data from `.graph.json`
3. Graph is converted into an adjacency list (GraphLoader)
4. Pathfinding algorithm (e.g., Dijkstra / BFS) runs
5. Shortest path is returned

---

##  Internal Architecture

* **types.ts**
  Defines Node, Edge, and Graph structures

* **GraphLoader.ts**
  Converts raw JSON into adjacency list

* **Pathfinding Algorithm**
  Computes shortest path using graph traversal

---

##  Example cURL Request

```bash
curl -X POST http://localhost:3000/indoor/route \
-H "Content-Type: application/json" \
-d '{
  "buildingId": "dc",
  "floor": 1,
  "startNodeId": "dc_f1_corridor_001",
  "endNodeId": "dc_f1_1317_door"
}'
```

---

##  Future Improvements

* Multi-floor navigation (stairs & elevators)
* Real-time congestion weighting
* Accessibility routing (wheelchair-friendly paths)
* Turn-by-turn instructions

---

##  Notes

* All edges are currently **bidirectional**
* Graph data must be preloaded before routing
* Node IDs must exist in the graph

---
