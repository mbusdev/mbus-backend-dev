# M-Bus Backend

## Setup

First, obtain an API key for the Magic Bus backend from [the official Magic Bus Website](https://mbus.ltp.umich.edu/dev-account).

Then, define the `MBUS_API_KEY` environment variable with your API key.

To install dependencies, run `npm i`

## (WIP) Firebase (Push Notifications) Setup

Create a Firebase project if you haven't already, and set `FIREBASE_PROJECT_ID` to its id. Follow the steps
[here](https://firebase.google.com/docs/admin/setup#initialize_the_sdk_in_non-google_environments) to create a service
account key file. Place this file into `secrets/` and point `GOOGLE_APPLICATION_CREDENTIALS` to it. 
(you can do this temporarily with export GOOGLE_APPLICATION_CREDENTIALS="./secrets/your-filename.json")

Some additional resources for iOS [here](https://firebase.flutter.dev/docs/messaging/apple-integration/). Make
sure that the firebase project is configured with the same app id as xcode.

## Running the Backend

To run the backend, run `npm start`.

By default, the service runs on port 3000. To define a port for the service to run on, define an environment variable called `PORT` before running the backend.

## Tests
To run tests, run `npm test`.
