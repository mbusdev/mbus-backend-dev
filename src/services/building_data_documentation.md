## MaizeBus Template for documenting features
## v0.1 by Shashank Madhu
## Steps for usage: 
## 1- Replace anything in parentheses with the specifications of your feature. 
## 2- Place the file in the same folder as your created files.
## 3- Send a copy of the document to your project team lead for review.

# OFFICIAL DOCUMENTATION FOR building_checker.ts AND merge_buildings.ts
**link to flowchart on figjam or alternative:** (link)
**Developer(s):** Shashank Madhu
**Feature / Algorithm Name:** Building Data Pipeline
* *Status:* [Draft / Under Review / Approved / Implemented]
* *Date:* [YYYY-MM-DD]
* *Reviewers:* (Your design plan should be at the very least approved by your team lead. You can and should also check this in with other people in and out of your subteam within MaizeBus. Once they are done, they should put their name in this column.) 

## Goals
To improve the usability of the app beyond campus buildings, users should be able to find how they can navigate to any building in Ann Arbor using MaizeBus's search. On the backend, my goal is to create an end-to-end data pipeline that takes all buildings from Ann Arbor and Ypsilanti from the compendium of Open Street Map (OSM) and delivers it to the frontend search.


## Core Algorithm / Behavioral Steps (Pseudocode / Logic flow)
Every week on Saturday night at 2am, the server will call building_checker.ts and merge_buildings.ts. All steps below will be repeated...
- 1: Several bounding boxes are drawn throughout Ann Arbor and Ypsilanti. Each bounding box will have a .json file that will house its data.
- 2: Call the API for each bounding box. This will populate .json files with all structure data in that area. If the API is not running, log and keep data that is currently within that program. 
- 3: Filter out all buildings that do not have an address. Within this process, if a building has an address but not latitude and/or longitude, then perform reverse geocoding to approximate a latitude/longitude.
- 4: Combine all bounding boxes, making sure to weed out duplicate addresses.
- 5: Combine file with pre-collected campus building data, being sure to weed out duplicate addresses. 
*For duplication, keep whichever data entry that have abbreviation. If neither entry has an abbreviation, keep whichever data entry has a name. This is to allow as many data entries as possible to search via abbreviation or name in the search.*

## Input 
a series of .xml files from the Open Street Map API. 

## Output
a .json file housing BuildingEntries of this structure:
interface BuildingEntry {
  ID: string; // ID from OSM
  lat: string; // latitude
  long: string;
  buildingName?: string;
  address: string;
}
* **Files Created:**
-/src/services/building_checker.ts (Steps 1-3)
-/src/services/merge_buildings.ts (Steps 4-5)
-/src/test/building_checker.test.ts (Test File)
* **Files Modified:**
-/src/jobs.ts (the two files created will be called in a seperate job every Sunday at 2 AM)



## Edge Cases
-OSM API fails (abort checking this bounding box, keep data currently in that box's file, try next bounding box)


## Testing Strategy 
-process box 3 of OSM buildings
    -writes valid JSON array
    -every entry has required fields ID, lat, long, address
    -buildingName, when present, is a non-empty string
    -includes buildings that have no name (buildingName is optional)
    -includes the known unnamed building at 800 Fuller Street
    -includes the named building Ann Arbor City Hall with correct address
    -includes more buildings than the previous node-only pass (29)
    -amount of buildings stays same when merged
-Calls API of a bounding box that will fail (or simulates an API fail)
    -tests error handling for this case, see Edge Cases


