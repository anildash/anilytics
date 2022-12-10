import express from "express";
import bodyParser from "body-parser";
import text2png from "text2png";
import fs from "fs";
import viperHTML, { wire } from "viperhtml";
import { table } from "./public/templates.js";
import filter from "./public/filter.js";
import http from "http";
import socketio from "socket.io";
import { open } from "sqlite";
import sqlite3 from "sqlite3";

["log", "warn", "error"].forEach(a => {
  let b = console[a];
  console[a] = (...c) => {
    try {
      throw new Error();
    } catch (d) {
      b.apply(console, [
        d.stack
          .split("\n")[2]
          .trim()
          .substring(3)
          .replace(__dirname, "")
          .replace(/\s\(./, " at ")
          .replace(/\)/, ""),
        "\n",
        ...c
      ]);
    }
  };
});

const asyncRender = viperHTML.async();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// init sqlite db
const dbFile = "./.data/sqlite.db";
open({ filename: dbFile, driver: sqlite3.Database })
  .then(async function(db) {
    // await db.run(`DROP TABLE IF EXISTS MiscInts`);
    // await db.run(`DROP TABLE IF EXISTS Analytics`);
    // await db.run(`DROP TABLE IF EXISTS DayCountLog`);
    // await db.run(`DROP TABLE IF EXISTS MonthCountLog`);
    // await db.run(`DROP TABLE IF EXISTS YesterdayLog`);
    // await db.run(`DROP TABLE IF EXISTS Last30`);

    await Promise.all([
      db.run(`CREATE TABLE IF NOT EXISTS Analytics (
        url TEXT PRIMARY KEY UNIQUE,
        counter INTEGER DEFAULT 0
      )`),
      db.run(`CREATE TABLE IF NOT EXISTS DayCountLog (
        DayNumber INTEGER PRIMARY KEY UNIQUE,
        value INTEGER DEFAULT 0
      )`),
      db.run(`CREATE TABLE IF NOT EXISTS Last30 (
        url TEXT PRIMARY KEY UNIQUE,
        counter INTEGER DEFAULT 0
      )`),
      db.run(`CREATE TABLE IF NOT EXISTS MonthCountLog (
        MonthNumber INTEGER PRIMARY KEY UNIQUE,
        count INTEGER DEFAULT 0
      )`),
      db.run(`CREATE TABLE IF NOT EXISTS MiscInts (
        IntKey TEXT PRIMARY KEY UNIQUE,
        value INTEGER DEFAULT 0
      )`),
      db.run(`CREATE TABLE IF NOT EXISTS YesterdayLog (
        url TEXT PRIMARY KEY UNIQUE,
        counter INTEGER DEFAULT 0
      )`),
      await db.run(`CREATE TABLE IF NOT EXISTS LastDay (
        url TEXT PRIMARY KEY,
        counter INTEGER DEFAULT 0
      )`)
    ]).catch(e => {
      console.log("Error Starting");
      throw e;
    });

    // Check for updating the tables
    await resetLast30Days();
    await resetLastDay();

    // A couple of useful functions for tidying up
    async function clearAllSingleVisits() {
      await db.run(`DELETE FROM Analytics WHERE counter = 1`);
    }

    async function clearAllMySQLInjections() {
      await db.run(`DELETE FROM Analytics WHERE instr(url, 'WAITFOR') > 0`);
      await db.run(`DELETE FROM Analytics WHERE instr(url, 'SLEEP') > 0`);
      await db.run(`DELETE FROM Analytics WHERE instr(url, 'ORDER') > 0`);
    }

    async function resetLast30Days() {
      const p = new Date();
      const currentMonth = p.getYear() * 12 + p.getMonth();

      const { value: monthBeingRecorded } = (await db.get(
        `SELECT value from MiscInts WHERE IntKey="Last30Month"`
      )) || { value: null };

      // If it's a new month reset everything
      if (monthBeingRecorded !== currentMonth) {
        const { counter: oldTotal } = (await db.get(
          `SELECT counter from Last30 WHERE url="global-counter"`
        )) || { counter: 0 };
        if (monthBeingRecorded)
          await db.run(`INSERT INTO MonthCountLog VALUES (?, ?)`, [
            monthBeingRecorded,
            oldTotal
          ]);
        await db.run(`DELETE FROM Last30`);

        console.log(`Updating Last30Month to ${currentMonth}`);
        await db.run(
          `INSERT OR REPLACE INTO MiscInts (IntKey, value) VALUES ("Last30Month", ?)`,
          currentMonth
        );
      }
    }

    async function resetLastDay() {
      const p = new Date();
      const currentDay = Math.floor(Date.now() / 8.64e7);

      const { value: dayBeingRecorded } = (await db.get(
        `SELECT value from MiscInts WHERE IntKey="LastDayDay"`
      )) || { value: null };

      // If it's a new Day reset everything
      if (dayBeingRecorded !== currentDay) {
        const { counter: oldTotal } = (await db.get(
          `SELECT counter from LastDay WHERE url="global-counter"`
        )) || { counter: 0 };

        if (dayBeingRecorded)
          await db.run(`INSERT INTO DayCountLog VALUES (?, ?)`, [
            dayBeingRecorded,
            oldTotal
          ]);

        // Get rid of the day before yesterdays Data
        await db.run(`DROP TABLE IF EXISTS YesterdayLog`);

        // Rename todays data to yesterday
        await db.run(`ALTER TABLE LastDay RENAME TO YesterdayLog`);

        // Recreate the table
        await db.run(`CREATE TABLE LastDay (
          url TEXT PRIMARY KEY,
          counter INTEGER DEFAULT 0
        )`);

        console.log(`Updating LastDayDay to ${currentDay}`);
        await db.run(
          `INSERT OR REPLACE INTO MiscInts (IntKey, value) VALUES ("LastDayDay", ?)`,
          currentDay
        );
      }
    }

    function nocache(req, res, next) {
      res.header(
        "Cache-Control",
        "private, no-cache, no-store, must-revalidate"
      );
      res.header("Expires", "-1");
      res.header("Pragma", "no-cache");
      next();
    }

    async function insertOrUpdate(dbName, urlToSave) {
      
      // Update the global counter
      const globalCounter = await db.get(
        `SELECT EXISTS(SELECT 1 FROM ${dbName} WHERE url = ?);`,
        "global-counter"
      );
      if (Object.values(globalCounter)[0] !== 0) {
        await db.run(
          `UPDATE ${dbName} SET counter = counter + 1 WHERE url = ?`,
          "global-counter"
        );
      } else {
        await db.run(`INSERT or REPLACE INTO ${dbName} VALUES (?, 1)`, "global-counter");
      }

      
      // Update the url counter
      const urlExists = await db.get(
        `SELECT EXISTS(SELECT 1 FROM ${dbName} WHERE url = ?);`,
        urlToSave
      );
      if (Object.values(urlExists)[0] !== 0) {
        await db.run(
          `UPDATE ${dbName} SET counter = counter + 1 WHERE url = ?`,
          urlToSave
        );
      } else {
        await db.run(`INSERT INTO ${dbName} VALUES (?, 1)`, urlToSave);
      }

      const { counter } = await db.get(
        `SELECT counter from ${dbName} WHERE url= ?`,
        urlToSave
      );
      return counter;
    }

    app.get("/counter.png", nocache, async function(request, response) {
      // Check to see if the day/month has changed.
      await resetLast30Days();
      await resetLastDay();

      const url =
        request.header("Referer") ||
        (request.query.fallback && "[fallback] " + request.query.fallback) ||
        "";

      if (request.header("DNT")) {
        const { counter: globalCounter } = (await db.get(
          `SELECT counter from Analytics WHERE url="global-counter"`
        )) || { counter: 0 };
        const img = text2png(globalCounter + "", {
          font: `${request.query.size || 16}px Open Sans`,
          textColor: request.query.color || "white",
          bgColor: "transparent",
          lineSpacing: 10,
          padding: 5
        });
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": img.length
        });
        response.end(img);
        return;
      }

      if (!url.match(filter)) {
        const img = text2png("URL Does not match filter", {
          font: `${request.query.size || 16}px Open Sans`,
          textColor: request.query.color || "white",
          bgColor: "transparent",
          lineSpacing: 10,
          padding: 5
        });
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": img.length
        });
        response.end(img);
        return;
      }

      const urlToSave = url ? url.split("?")[0] : "unknown";

      let urlCounter;
      try {
        urlCounter = {
          Analytics: await insertOrUpdate("Analytics", urlToSave),
          Last30: await insertOrUpdate("Last30", urlToSave),
          LastDay: await insertOrUpdate("LastDay", urlToSave)
        };
      } catch (e) {
        const img = text2png("error", {
          font: `${request.query.size || 16}px Open Sans`,
          textColor: request.query.color || "white",
          bgColor: "transparent",
          lineSpacing: 10,
          padding: 5
        });
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": img.length
        });
        response.end(img);
        console.log(e);
        return;
      }

      io.sockets.emit("update", { url: urlToSave, urlCounter });

      const { counter: globalCounter } = (await db.get(
        `SELECT counter from Analytics WHERE url="global-counter"`
      )) || { counter: 0 };
      const img = text2png(globalCounter + "", {
        font: `${request.query.size || 16}px Open Sans`,
        textColor: request.query.color || "white",
        bgColor: "transparent",
        lineSpacing: 10,
        padding: 5
      });
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": img.length
      });
      response.end(img);
    });

    const indexFile = fs
      .readFileSync("./views/index.html", "utf8")
      .split("<!-- split -->");
    app.get("/", async function(req, res) {
      res.set({ "content-type": "text/html; charset=utf-8" });

      const dbName = req.query.db || "Analytics";

      if (
        !(
          dbName === "Analytics" ||
          dbName === "Last30" ||
          dbName === "YesterdayLog" ||
          dbName === "LastDay"
        )
      ) {
        return res.end("Not a valid DB");
      }

      const rows = await db.all(
        `SELECT * from ${dbName} ORDER BY counter desc`
      );
      asyncRender(chunk => res.write(chunk))`
        ${{ html: indexFile[0] }}
        <svg xmlns="http://www.w3.org/2000/svg" style="display:block; width: 100%; height: 100px;" id="chart">${wire(
          {},
          "svg"
        )`
          ${db
            .all("SELECT * from DayCountLog ORDER BY DayNumber desc LIMIT 30")
            .then(rows => {
              const max = Math.max(
                rows.reduce((a, b) => Math.max(a, b.value), 0),
                1
              );
              const elements = rows.map(
                (row, i) => wire(row, "svg")`<g class="bar">
                <rect width="3.33%" x="${100 - 3.33 * (i + 1) + "%"}" y="${80 *
                  (1 - row.value / max) +
                  "%"}" height="${80 * (row.value / max) + "%"}"></rect>
                <text x="${100 - 3.33 * (i + 1) + "%"}" y="${Math.max(
                  -1 + 80 * (1 - row.value / max),
                  12
                ) + "%"}" dx="1.666%" text-anchor="middle">${row.value}</text>
              </g>`
              );
              elements.unshift(wire({}, "svg")`
                <title id="title">A bar chart of users per day.</title>
                <desc id="desc">Most users in the last 30 days was ${max}.</desc>
                <text x="100%" y="80%" dy="1.1em" text-anchor="end">Yesterday</text>
                <text x="0%" y="80%" dy="1.1em" text-anchor="start">30 Days Ago</text>
                <rect width="100%" x="0" y="80%" height="1" style="stroke: none;"></rect>
              `);
              return elements;
            })}
        `}</svg>
        ${{ html: indexFile[1] }}
        ${table(dbName, rows)}
        ${{ html: indexFile[2] }}
    `.then(() => res.end());
    });

    app.get("/day-histogram.json", nocache, async function(request, response) {
      const rows = await db.all(
        "SELECT * from DayCountLog ORDER BY DayNumber desc LIMIT 30"
      );
      response.json(rows);
    });

    app.get("/last-30-days-count.json", nocache, async function(
      request,
      response
    ) {
      const count = await db.get(
        "SELECT SUM(value) as count from DayCountLog WHERE DayNumber > (SELECT MAX(DayNumber) from DayCountLog) - 30"
      );
      response.json(count);
    });

    app.get("/data.json", nocache, async function(request, response) {
      const rows = await db.all(
        "SELECT * from Analytics ORDER BY counter desc"
      );
      response.json(rows);
    });

    app.get("/yesterday.json", nocache, async function(request, response) {
      const rows = await db.all(
        "SELECT * from YesterdayLog ORDER BY counter desc"
      );
      response.json(rows);
    });

    app.get("/since-yesterday.json", nocache, async function(
      request,
      response
    ) {
      const rows = await db.all("SELECT * from LastDay ORDER BY counter desc");
      response.json(rows);
    });

    app.get("/since-last-month.json", nocache, async function(
      request,
      response
    ) {
      const rows = await db.all("SELECT * from Last30 ORDER BY counter desc");
      response.json(rows);
    });

    app.use(
      "/node_modules/viperhtml/index.js",
      express.static("./node_modules/hyperhtml/esm.js")
    );
    app.use(express.static("public"));

    const server = http.createServer(app);
    server.listen(process.env.PORT, function() {
      console.log("Your app is listening on port " + process.env.PORT);
    });

    const io = socketio(server);
    io.on("connection", function(client) {
      client.on("event", function(data) {});
      client.on("disconnect", function() {});
    });
  })
  .catch(e => console.log(e.stack.split("\n")));
