## Local Docker Setup

This backend can be run locally with Docker Compose. In the current local development setup, only the Node.js backend runs inside Docker. MongoDB is not started as a new Docker container. Instead, the backend container connects to the existing MongoDB instance running on the WSL/local machine.

This is intentional because the local MongoDB already contains the `indoor_navigation` database and the `floorGraphs` collection used by the indoor navigation feature.

### Architecture

```txt
Client / curl / frontend
    ↓
localhost:3000
    ↓
Docker container: mbus-backend
    ↓
host.docker.internal:27017
    ↓
Local WSL MongoDB
Docker Compose Configuration

The local Docker Compose setup uses the following structure:

version: "3.8"

services:
  backend:
    build: .
    container_name: mbus-backend
    restart: unless-stopped
    ports:
      - "3000:3000"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      INDOOR_MONGO_URI: mongodb://host.docker.internal:27017

The important environment variable is:

INDOOR_MONGO_URI=mongodb://host.docker.internal:27017

Inside a Docker container, 127.0.0.1 refers to the container itself, not the WSL host machine. Therefore, the backend uses host.docker.internal to connect from the Docker container back to the local MongoDB instance.

Start MongoDB

Before starting the backend container, make sure the local MongoDB service is running:

sudo service mongod start

You can verify that the indoor navigation data exists with:

mongosh indoor_navigation --eval 'db.floorGraphs.find({}, {buildingId:1, floor:1, _id:0}).limit(5).toArray()'

A valid result should include documents similar to:

[
  { buildingId: "dc", floor: 1 }
]
Start the Backend with Docker Compose

From the project root directory, run:

docker-compose up --build

After the container starts successfully, the backend should be available at:

http://localhost:3000
Test the Indoor Route API

In a separate terminal, run:

curl -X POST http://localhost:3000/mbus/api/v3/indoor/route \
  -H "Content-Type: application/json" \
  -d '{
    "startNodeId": "dc_f1_corridor_1",
    "endNodeId": "dc_f1_1317_sw_door"
  }'

A successful response should include:

{
  "startNodeId": "dc_f1_corridor_1",
  "endNodeId": "dc_f1_1317_sw_door",
  "loadedTargets": [
    {
      "buildingId": "dc",
      "floor": 1
    }
  ],
  "nodePath": [
    "dc_f1_corridor_1",
    "dc_f1_1L01_door",
    "dc_f1_corridor_2"
  ],
  "steps": [
    {
      "from": "dc_f1_corridor_1",
      "to": "dc_f1_1L01_door",
      "edgeId": "dc_f1_1L01_door__dc_f1_corridor_1",
      "cost": 2.65,
      "type": "walk"
    }
  ],
  "totalCost": 39.8
}

The exact path may differ depending on the graph data stored in MongoDB.

Indoor Navigation Endpoints
Get a Floor Graph
GET /mbus/api/v3/indoor/graph?buildingId=dc&floor=1

This endpoint returns the indoor graph data for a specific building and floor.

Compute an Indoor Route
POST /mbus/api/v3/indoor/route

Request body:

{
  "startNodeId": "dc_f1_corridor_1",
  "endNodeId": "dc_f1_1317_sw_door"
}

The backend will:

Parse the start and end node IDs.
Determine which building and floor graphs need to be loaded.
Fetch the graph documents from MongoDB.
Load the graph data into adjacency-list form.
Merge the required graph data.
Run the A* pathfinding algorithm.
Return the final route as nodePath, steps, and totalCost.
Common Issues
connect ECONNREFUSED 172.17.0.1:27017

This usually means the backend container can reach the host address, but MongoDB is not accepting connections from the Docker bridge network.

Check the MongoDB config file:

sudo nano /etc/mongod.conf

For local development, the net section can be configured like this:

net:
  port: 27017
  bindIp: 127.0.0.1,172.17.0.1

Then restart MongoDB:

sudo service mongod restart
Cannot POST /indoor/route

The backend API is mounted under the MBus API prefix. Use:

/mbus/api/v3/indoor/route

not:

/indoor/route
docker compose does not work

Some local environments may only have the older Docker Compose command installed. In that case, use:

docker-compose up --build

instead of:

docker compose up --build
Current Status

The backend Docker setup currently supports:

Building the Node.js backend image with Docker.
Running the backend in a Docker container.
Exposing the backend on localhost:3000.
Connecting from the backend container to the existing local MongoDB instance.
Reading indoor navigation graph data from MongoDB.
Computing indoor routes through the /mbus/api/v3/indoor/route endpoint.