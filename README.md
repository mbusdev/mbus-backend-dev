# Maizebus Backend
<img src="static/logo.png" width="75" alt="Maisebus Logo">

Backend service for the Magic Bus application. Handles real-time bus tracking, route management, and multi-modal journey planning (bus + walking) using the McRaptor algorithm.

## Setup

First, obtain an API key for the Magic Bus backend from [the official Magic Bus Website](https://mbus.ltp.umich.edu/dev-account).

Then, define the `MBUS_API_KEY` environment variable with your API key.

To install dependencies, run `npm i`

## Running the Backend

To run the backend, run `npm start`.

By default, the service runs on port 3000. To define a port for the service to run on, define an environment variable called `PORT` before running the backend.

## Documentation

This project uses TSDoc for code documentation.
To compile the static documentation:
```bash
npm run docs
```
The documentation is served at `http://localhost:3000/docs` or this [link](https://mbusdev.github.io/mbus-backend-dev/).

## Tests

This project uses **Vitest** for fast unit and integration testing.

- Run all tests: `npm test`
- Run stress tests: `npm run stress-test`

An example of passing the tests is below.

<img src="static/test_example.png" width="300" alt="test example">


## Contributing
Before submitting a pull request to main, please make sure you pass all the tests and can compile docs. If you believe some of the tests faulty or no longer needed after your commit, please contact Andrew Yu or Ryan Lu on Slack.