// ============================================================
// LIVE CANVAS - SERVER
// Express + Socket.IO + NeonDB
// Real-Time Collaborative Board Server
// ============================================================

require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { Pool } = require("pg");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcrypt");


// ============================================================
// APP SETUP
// ============================================================

const app = express();

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ============================================================
// NEONDB POOL
// ============================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});


// ============================================================
// INIT DATABASE TABLES
// ============================================================

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                profile_pic_idx TEXT NOT NULL DEFAULT '1',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS boards (
                id TEXT NOT NULL,
                owner_email TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT 'Untitled',
                canvas_style TEXT NOT NULL DEFAULT 'grid',
                color_index INT NOT NULL DEFAULT 0,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                PRIMARY KEY (id, owner_email)
            );

            CREATE TABLE IF NOT EXISTS board_states (
                board_id TEXT PRIMARY KEY,
                state JSONB NOT NULL,
                updated_at BIGINT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session (
                sid VARCHAR NOT NULL COLLATE "default",
                sess JSON NOT NULL,
                expire TIMESTAMP(6) NOT NULL,
                PRIMARY KEY (sid)
            );

            CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);
        `);
        console.log("NeonDB tables ready.");
    } catch (err) {
        console.error("DB init error:", err.message);
    }
}

initDB();


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json({
    limit: "10mb"
}));

app.use(session({
    store: new pgSession({
        pool,
        tableName: "session",
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || "livecanvas-fallback-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: false,
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));


// ============================================================
// AUTH MIDDLEWARE
// ============================================================

function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    next();
}


// ============================================================
// REST — AUTH
// ============================================================

// POST /api/auth/signup
app.post("/api/auth/signup", async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: "All fields are required." });
        }

        const existing = await pool.query(
            "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
            [email]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({ error: "Account already exists." });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const profilePicIdx = String(Math.floor(Math.random() * 5) + 1);

        const result = await pool.query(
            `INSERT INTO users (name, email, password_hash, profile_pic_idx)
             VALUES ($1, $2, $3, $4)
             RETURNING id, name, email, profile_pic_idx`,
            [name.trim(), email.trim().toLowerCase(), passwordHash, profilePicIdx]
        );

        const user = result.rows[0];

        req.session.user = {
            id: user.id,
            name: user.name,
            email: user.email,
            profilePicIdx: user.profile_pic_idx
        };

        return res.json({ user: req.session.user });

    } catch (err) {
        console.error("Signup error:", err.message);
        return res.status(500).json({ error: "Server error during signup." });
    }
});


// POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required." });
        }

        const result = await pool.query(
            "SELECT * FROM users WHERE LOWER(email) = LOWER($1)",
            [email.trim()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: "No account exists. Create a new one." });
        }

        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);

        if (!valid) {
            return res.status(401).json({ error: "Invalid email or password." });
        }

        req.session.user = {
            id: user.id,
            name: user.name,
            email: user.email,
            profilePicIdx: user.profile_pic_idx
        };

        return res.json({ user: req.session.user });

    } catch (err) {
        console.error("Login error:", err.message);
        return res.status(500).json({ error: "Server error during login." });
    }
});


// POST /api/auth/logout
app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: "Could not log out." });
        }
        res.clearCookie("connect.sid");
        return res.json({ ok: true });
    });
});


// GET /api/auth/me
app.get("/api/auth/me", (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    return res.json({ user: req.session.user });
});


// ============================================================
// REST — BOARDS
// ============================================================

// GET /api/boards — list boards for logged-in user
app.get("/api/boards", requireAuth, async (req, res) => {
    try {
        const { email } = req.session.user;
        const result = await pool.query(
            `SELECT id, name, canvas_style, color_index, created_at, updated_at
             FROM boards WHERE owner_email = $1
             ORDER BY created_at DESC`,
            [email]
        );
        return res.json({ boards: result.rows.map(r => ({
            id: r.id,
            name: r.name,
            canvasStyle: r.canvas_style,
            colorIndex: r.color_index,
            created: Number(r.created_at),
            updated: Number(r.updated_at)
        })) });
    } catch (err) {
        console.error("GET /api/boards error:", err.message);
        return res.status(500).json({ error: "Could not load boards." });
    }
});


// POST /api/boards — create or join a board
app.post("/api/boards", requireAuth, async (req, res) => {
    try {
        const { email } = req.session.user;
        const { id, name, canvasStyle, colorIndex } = req.body;

        if (!id || !name) {
            return res.status(400).json({ error: "id and name are required." });
        }

        const now = Date.now();

        await pool.query(
            `INSERT INTO boards (id, owner_email, name, canvas_style, color_index, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id, owner_email) DO NOTHING`,
            [
                id.toUpperCase(),
                email,
                name,
                canvasStyle || "grid",
                colorIndex || 0,
                now,
                now
            ]
        );

        const result = await pool.query(
            `SELECT id, name, canvas_style, color_index, created_at, updated_at
             FROM boards WHERE id = $1 AND owner_email = $2`,
            [id.toUpperCase(), email]
        );

        const board = result.rows[0];

        return res.json({
            board: {
                id: board.id,
                name: board.name,
                canvasStyle: board.canvas_style,
                colorIndex: board.color_index,
                created: Number(board.created_at),
                updated: Number(board.updated_at)
            }
        });

    } catch (err) {
        console.error("POST /api/boards error:", err.message);
        return res.status(500).json({ error: "Could not save board." });
    }
});


// PATCH /api/boards/:id — update board name or canvas style
app.patch("/api/boards/:id", requireAuth, async (req, res) => {
    try {
        const { email } = req.session.user;
        const boardId = req.params.id.toUpperCase();
        const { name, canvasStyle } = req.body;

        const fields = [];
        const values = [];
        let idx = 1;

        if (name !== undefined) {
            fields.push(`name = $${idx++}`);
            values.push(name);
        }

        if (canvasStyle !== undefined) {
            fields.push(`canvas_style = $${idx++}`);
            values.push(canvasStyle);
        }

        if (fields.length === 0) {
            return res.status(400).json({ error: "Nothing to update." });
        }

        fields.push(`updated_at = $${idx++}`);
        values.push(Date.now());
        values.push(boardId);
        values.push(email);

        await pool.query(
            `UPDATE boards SET ${fields.join(", ")}
             WHERE id = $${idx++} AND owner_email = $${idx}`,
            values
        );

        return res.json({ ok: true });

    } catch (err) {
        console.error("PATCH /api/boards error:", err.message);
        return res.status(500).json({ error: "Could not update board." });
    }
});


// DELETE /api/boards/:id — remove board from user's list
app.delete("/api/boards/:id", requireAuth, async (req, res) => {
    try {
        const { email } = req.session.user;
        const boardId = req.params.id.toUpperCase();

        await pool.query(
            "DELETE FROM boards WHERE id = $1 AND owner_email = $2",
            [boardId, email]
        );

        return res.json({ ok: true });

    } catch (err) {
        console.error("DELETE /api/boards error:", err.message);
        return res.status(500).json({ error: "Could not delete board." });
    }
});


// ============================================================
// SERVE FRONTEND
// ============================================================

const rootDirectory =
    path.join(__dirname, "..");


// Home page
app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            rootDirectory,
            "home.html"
        )
    );

});


// Static frontend files
app.use(
    express.static(rootDirectory)
);


// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {

    res.json({
        status: "ok",
        service: "LiveCanvas",
        boards: boards.size,
        time: new Date().toISOString()
    });

});


// ============================================================
// BOARD STORAGE
// ============================================================
//
// Every board has its own state.
//
// Example:
//
// boards
//   └── DUKYTOHY
//         ├── users
//         ├── canvasStyle
//         ├── pages
//         ├── currentPage
//         ├── zoom
//         ├── title
//         ├── drawingOperations
//         └── objects
//
// This is server memory for now.
// Later this can easily be moved to MongoDB/PostgreSQL/Redis.
//

const boards = new Map();


// ============================================================
// CREATE DEFAULT BOARD STATE
// ============================================================

function createDefaultBoard(boardId, canvasStyle = "blank") {

    return {

        boardId,

        title: "",

        canvasStyle,

        currentPage: 0,

        pages: [
            {
                id: "page-1",
                height: 700,
                canvasData: null,

                // Drawing operations for this page
                drawings: [],

                // Text, shapes, images, sticky notes, tables
                objects: []
            }
        ],

        updatedAt: Date.now()

    };

}


// ============================================================
// GET OR CREATE BOARD
// ============================================================

function getBoard(boardId, initialCanvasStyle = "blank") {

    if (!boards.has(boardId)) {

        const validStyles = ["blank", "grid", "dots", "lines"];
        const canvasStyle = validStyles.includes(initialCanvasStyle)
            ? initialCanvasStyle
            : "blank";

        boards.set(
            boardId,
            createDefaultBoard(boardId, canvasStyle)
        );

        console.log(
            `Created new board: ${boardId}`
        );

    }

    return boards.get(boardId);

}

const saveDebounceMap = new Map();

function persistBoardState(boardId) {
    if (!boardId) return;
    if (saveDebounceMap.has(boardId)) {
        clearTimeout(saveDebounceMap.get(boardId));
    }
    const timer = setTimeout(async () => {
        saveDebounceMap.delete(boardId);
        const board = boards.get(boardId);
        if (!board) return;
        try {
            await pool.query(
                `INSERT INTO board_states (board_id, state, updated_at)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (board_id) DO UPDATE
                 SET state = $2, updated_at = $3`,
                [boardId, JSON.stringify(board), Date.now()]
            );
        } catch (err) {
            console.error("Error saving board state to NeonDB:", err.message);
        }
    }, 500);
    saveDebounceMap.set(boardId, timer);
}

async function loadBoard(boardId, initialCanvasStyle = "blank") {
    if (boards.has(boardId)) {
        return boards.get(boardId);
    }
    try {
        const res = await pool.query(
            "SELECT state FROM board_states WHERE board_id = $1",
            [boardId]
        );
        if (res.rows.length > 0 && res.rows[0].state) {
            const raw = res.rows[0].state;
            const state = typeof raw === "string" ? JSON.parse(raw) : raw;
            boards.set(boardId, state);
            console.log(`Loaded board from NeonDB: ${boardId}`);
            return state;
        }
    } catch (err) {
        console.error("Error loading board from NeonDB:", err.message);
    }
    return getBoard(boardId, initialCanvasStyle);
}


// ============================================================
// VALIDATE BOARD ID
// ============================================================

function cleanBoardId(boardId) {

    if (
        typeof boardId !== "string"
    ) {
        return null;
    }

    const cleaned =
        boardId.trim();

    if (!cleaned) {
        return null;
    }

    // Prevent absurdly large IDs
    if (cleaned.length > 100) {
        return null;
    }

    return cleaned;

}


// ============================================================
// VALIDATE USERNAME
// ============================================================

function cleanUsername(username) {

    if (
        typeof username !== "string"
    ) {
        return null;
    }

    const cleaned =
        username.trim();

    if (!cleaned) {
        return null;
    }

    if (cleaned.length > 100) {
        return cleaned.substring(0, 100);
    }

    return cleaned;

}


// ============================================================
// GET USERS IN BOARD
// ============================================================

function getBoardUsers(boardId) {

    const room =
        io.sockets.adapter.rooms.get(
            boardId
        );

    if (!room) {
        return [];
    }

    const users = [];
    const seen = new Set();

    for (const socketId of room) {

        const userSocket =
            io.sockets.sockets.get(
                socketId
            );

        if (
            userSocket &&
            userSocket.username &&
            !seen.has(userSocket.username)
        ) {
            seen.add(userSocket.username);

            users.push({
                username: userSocket.username,
                profileIdx: userSocket.profileIdx || "1"
            });

        }

    }

    return users;

}


// ============================================================
// GET USER COUNT
// ============================================================

function getUserCount(boardId) {

    return getBoardUsers(boardId).length;

}


// ============================================================
// SANITIZE DRAW OPERATION
// ============================================================

function sanitizeDrawing(data) {

    if (!data || typeof data !== "object") {
        return null;
    }

    const x1 = Number(data.x1);
    const y1 = Number(data.y1);
    const x2 = Number(data.x2);
    const y2 = Number(data.y2);

    if (
        !Number.isFinite(x1) ||
        !Number.isFinite(y1) ||
        !Number.isFinite(x2) ||
        !Number.isFinite(y2)
    ) {
        return null;
    }

    const allowedTools = [
        "pen",
        "eraser",
        "highlighter",
        "lightPen"
    ];

    const tool =
        allowedTools.includes(data.tool)
            ? data.tool
            : "pen";

    const lineWidth =
        Number(data.lineWidth);

    return {

        x1,
        y1,
        x2,
        y2,

        color:
            typeof data.color === "string"
                ? data.color
                : "#172033",

        lineWidth:
            Number.isFinite(lineWidth)
                ? Math.max(
                    1,
                    Math.min(
                        lineWidth,
                        100
                    )
                )
                : 4,

        tool

    };

}


// ============================================================
// SOCKET CONNECTION
// ============================================================

io.on("connection", (socket) => {

    console.log(
        "User connected:",
        socket.id
    );


    // ========================================================
    // JOIN ROOM
    // ========================================================

    socket.on(
        "join-room",
        async (boardId, username, profileIdx, initialCanvasStyle) => {

            boardId =
                cleanBoardId(boardId);

            username =
                cleanUsername(username);


            // ------------------------------------------------
            // VALIDATION
            // ------------------------------------------------

            if (!boardId) {

                console.log(
                    "Join rejected: invalid board"
                );

                socket.emit(
                    "join-error",
                    {
                        message:
                            "Invalid board ID."
                    }
                );

                return;
            }


            if (!username) {

                console.log(
                    "Join rejected: username missing"
                );

                socket.emit(
                    "join-error",
                    {
                        message:
                            "Username is required."
                    }
                );

                return;
            }


            // ------------------------------------------------
            // LEAVE PREVIOUS BOARD IF NECESSARY
            // ------------------------------------------------

            if (
                socket.boardId &&
                socket.boardId !== boardId
            ) {

                socket.leave(
                    socket.boardId
                );

            }


            // ------------------------------------------------
            // STORE SOCKET INFORMATION
            // ------------------------------------------------

            socket.boardId =
                boardId;

            socket.username =
                username;

            socket.profileIdx =
                String(profileIdx || "1");


            // ------------------------------------------------
            // GET / CREATE BOARD (LOAD FROM NEONDB)
            // ------------------------------------------------

            const board =
                await loadBoard(boardId, initialCanvasStyle);


            // ------------------------------------------------
            // JOIN SOCKET.IO ROOM
            // ------------------------------------------------

            socket.join(boardId);


            console.log(
                `${username} joined board ${boardId}`
            );


            // ------------------------------------------------
            // GET CURRENT USERS
            // ------------------------------------------------

            const users =
                getBoardUsers(boardId);

            const userCount =
                users.length;


            // ------------------------------------------------
            // SEND BOARD INFORMATION
            // ------------------------------------------------

            socket.emit(
                "room-joined",
                {

                    boardId: boardId,
    username: username,
    userCount: userCount,
    users: users,

    // IMPORTANT
    canvasStyle: board.canvasStyle,

                    // Current board state
                    boardState: board

                }
            );


            // ------------------------------------------------
            // SEND BOARD STATE SEPARATELY
            // ------------------------------------------------
            //
            // This gives the frontend a clean event to listen
            // to when we update script.js.
            //

            socket.emit(
                "board-state",
                board
            );


            // ------------------------------------------------
            // INFORM OTHER USERS
            // ------------------------------------------------

            socket.to(
                boardId
            ).emit(
                "user-joined",
                {

                    username,

                    userCount,

                    users

                }
            );


            console.log(
                "Board:",
                boardId
            );

            console.log(
                "Users:",
                users
            );

            console.log(
                "User count:",
                userCount
            );

        }
    );


    // ========================================================
    // CANVAS DRAW
    // ========================================================
    //
    // Existing frontend already sends:
    //
    // socket.emit("canvas-draw", data)
    //
    // So this remains compatible.
    //

    // ============================================================
// CANVAS STYLE SYNC
// ============================================================

socket.on("canvas-style-change", (data) => {

    if (!socket.boardId || !data) {
        return;
    }

    const style =
        typeof data.style === "string"
            ? data.style.trim().toLowerCase()
            : "blank";

    const validStyles = [
        "blank",
        "grid",
        "dots",
        "lines"
    ];

    if (!validStyles.includes(style)) {
        return;
    }

    // Keep the style on the board that is sent to clients when they join.
    const boardState = getBoard(socket.boardId);

    boardState.canvasStyle = style;

    persistBoardState(socket.boardId);

    console.log(
        `Canvas style changed: ${socket.boardId} -> ${style}`
    );

    // Send to EVERY OTHER USER in this board
    socket.to(socket.boardId).emit(
        "canvas-style-change",
        {
            style: style
        }
    );
});

    socket.on(
        "canvas-draw",
        (data) => {

            if (
                !socket.boardId ||
                !data
            ) {
                return;
            }


            const drawing =
                sanitizeDrawing(data);

            if (!drawing) {
                return;
            }


            const board =
                getBoard(
                    socket.boardId
                );


            // ------------------------------------------------
            // CURRENT PAGE
            // ------------------------------------------------

            const pageIndex =
                Number.isInteger(
                    data.pageIndex
                )
                    ? data.pageIndex
                    : board.currentPage;


            // ------------------------------------------------
            // MAKE SURE PAGE EXISTS
            // ------------------------------------------------

            while (
                board.pages.length <= pageIndex
            ) {

                board.pages.push({

                    id:
                        `page-${board.pages.length + 1}`,

                    height: 700,

                    drawings: [],

                    objects: []

                });

            }


            // ------------------------------------------------
            // STORE DRAWING
            // ------------------------------------------------

            board.pages[
                pageIndex
            ].drawings.push(
                drawing
            );


            // ------------------------------------------------
            // UPDATE BOARD
            // ------------------------------------------------

            board.updatedAt =
                Date.now();

            persistBoardState(socket.boardId);


            // ------------------------------------------------
            // BROADCAST TO OTHER USERS
            // ------------------------------------------------

            socket.to(
                socket.boardId
            ).emit(
                "canvas-draw",
                {

                    ...drawing,

                    pageIndex

                }
            );

        }
    );


    // ========================================================
    // CANVAS STYLE
    // ========================================================
    //
    // Frontend will use this when the user changes:
    //
    // blank
    // grid
    // dots
    // lines
    //

    socket.on(
        "canvas-style",
        (data) => {

            if (!socket.boardId) {
                return;
            }


            let style = data;

            if (
                data &&
                typeof data === "object"
            ) {

                style =
                    data.style;

            }


            if (
                typeof style !== "string"
            ) {

                return;

            }


            const allowedStyles = [
                "blank",
                "grid",
                "dots",
                "lines"
            ];


            if (
                !allowedStyles.includes(style)
            ) {

                return;

            }


            const board =
                getBoard(
                    socket.boardId
                );


            board.canvasStyle =
                style;

            board.updatedAt =
                Date.now();


            socket.to(
                socket.boardId
            ).emit(
                "canvas-style",
                {

                    style

                }
            );


            console.log(
                `Canvas style changed: ${socket.boardId} -> ${style}`
            );

        }
    );


    // ========================================================
    // SAVE BOARD STATE (FROM FRONTEND SCHEDULE / AUTO-SAVE)
    // ========================================================

    socket.on(
        "save-board-state",
        (incomingState) => {

            if (!socket.boardId || !incomingState || typeof incomingState !== "object") {
                return;
            }

            const board = getBoard(socket.boardId);

            if (typeof incomingState.title === "string" && incomingState.title.trim()) {
                board.title = incomingState.title.trim();
            }

            if (typeof incomingState.canvasStyle === "string") {
                const allowedStyles = ["blank", "grid", "dots", "lines"];
                if (allowedStyles.includes(incomingState.canvasStyle)) {
                    board.canvasStyle = incomingState.canvasStyle;
                }
            }

            if (Number.isInteger(incomingState.currentPage)) {
                board.currentPage = Math.max(0, incomingState.currentPage);
            }

            if (Array.isArray(incomingState.pages)) {
                board.pages = sanitizePages(incomingState.pages);
            }

            board.updatedAt = Date.now();

            persistBoardState(socket.boardId);

            socket.to(socket.boardId).emit("board-state", board);
        }
    );


    // ========================================================
    // DOCUMENT STATE
    // ========================================================
    //
    // Used for:
    //
    // title
    // zoom
    // current page
    // pages
    // canvas style
    //
    // This is the main synchronization event.
    //

    socket.on(
        "document-state",
        (incomingState) => {

            if (!socket.boardId) {
                return;
            }

            if (
                !incomingState ||
                typeof incomingState !== "object"
            ) {
                return;
            }


            const board =
                getBoard(
                    socket.boardId
                );


            // ------------------------------------------------
            // TITLE
            // ------------------------------------------------

            if (
                typeof incomingState.title ===
                "string"
            ) {

                board.title =
                    incomingState.title;

            }


            // ------------------------------------------------
            // CANVAS STYLE
            // ------------------------------------------------

            if (
                typeof incomingState.canvasStyle ===
                "string"
            ) {

                const allowedStyles = [
                    "blank",
                    "grid",
                    "dots",
                    "lines"
                ];

                if (
                    allowedStyles.includes(
                        incomingState.canvasStyle
                    )
                ) {

                    board.canvasStyle =
                        incomingState.canvasStyle;

                }

            }


            // ------------------------------------------------
            // CURRENT PAGE
            // ------------------------------------------------

            if (
                Number.isInteger(
                    incomingState.currentPage
                )
            ) {

                board.currentPage =
                    Math.max(
                        0,
                        incomingState.currentPage
                    );

            }


            // ------------------------------------------------
            // PAGES
            // ------------------------------------------------

            if (
                Array.isArray(
                    incomingState.pages
                )
            ) {

                board.pages =
                    sanitizePages(
                        incomingState.pages
                    );

            }


            // ------------------------------------------------
            // UPDATE TIME
            // ------------------------------------------------

            board.updatedAt =
                Date.now();

            persistBoardState(socket.boardId);


            // ------------------------------------------------
            // BROADCAST
            // ------------------------------------------------

            socket.to(
                socket.boardId
            ).emit(
                "document-state",
                board
            );

        }
    );


    // ========================================================
    // FULL BOARD STATE
    // ========================================================
    //
    // Useful when the frontend wants to explicitly push
    // the complete board.
    //

    socket.on(
        "board-state-update",
        (incomingState) => {

            if (!socket.boardId) {
                return;
            }

            if (
                !incomingState ||
                typeof incomingState !== "object"
            ) {
                return;
            }


            const board =
                getBoard(
                    socket.boardId
                );


            const sanitized =
                sanitizeBoardState(
                    incomingState,
                    board
                );


            boards.set(
                socket.boardId,
                sanitized
            );

            persistBoardState(socket.boardId);


            socket.to(
                socket.boardId
            ).emit(
                "board-state",
                sanitized
            );

        }
    );


    // ========================================================
    // OBJECT ADD
    // ========================================================
    //
    // Text
    // Shape
    // Image
    // Sticky
    // Table
    //

    socket.on(
        "object-add",
        (data) => {

            if (!socket.boardId) {
                return;
            }

            if (
                !data ||
                typeof data !== "object"
            ) {
                return;
            }


            const board =
                getBoard(
                    socket.boardId
                );


            const pageIndex =
                Number.isInteger(
                    data.pageIndex
                )
                    ? data.pageIndex
                    : board.currentPage;


            while (
                board.pages.length <= pageIndex
            ) {

                board.pages.push({

                    id:
                        `page-${board.pages.length + 1}`,

                    height: 700,

                    drawings: [],

                    objects: []

                });

            }


            const object =
                sanitizeObject(
                    data.object || data
                );


            if (!object) {
                return;
            }


            board.pages[
                pageIndex
            ].objects.push(
                object
            );


            board.updatedAt =
                Date.now();

            persistBoardState(socket.boardId);


            socket.to(
                socket.boardId
            ).emit(
                "object-add",
                {

                    object,

                    pageIndex

                }
            );

        }
    );


    // ========================================================
    // OBJECT UPDATE
    // ========================================================

    socket.on(
        "object-update",
        (data) => {

            if (!socket.boardId) {
                return;
            }

            if (
                !data ||
                typeof data !== "object"
            ) {
                return;
            }


            const board =
                getBoard(
                    socket.boardId
                );


            const pageIndex =
                Number.isInteger(
                    data.pageIndex
                )
                    ? data.pageIndex
                    : board.currentPage;


            const objectId =
                data.objectId || data.id;


            if (
                !objectId ||
                !board.pages[pageIndex]
            ) {

                return;

            }


            const objectIndex =
                board.pages[
                    pageIndex
                ].objects.findIndex(
                    object =>
                        object.id === objectId
                );


            if (
                objectIndex === -1
            ) {

                return;

            }


            const updatedObject =
                sanitizeObject(
                    data.object || data
                );


            if (!updatedObject) {
                return;
            }


            board.pages[
                pageIndex
            ].objects[
                objectIndex
            ] =
                updatedObject;


            board.updatedAt =
                Date.now();

            persistBoardState(socket.boardId);


            socket.to(
                socket.boardId
            ).emit(
                "object-update",
                {

                    objectId,

                    object:
                        updatedObject,

                    pageIndex

                }
            );

        }
    );


    // ========================================================
    // OBJECT DELETE
    // ========================================================

    socket.on(
        "object-delete",
        (data) => {

            if (!socket.boardId) {
                return;
            }

            if (
                !data ||
                typeof data !== "object"
            ) {
                return;
            }


            const board =
                getBoard(
                    socket.boardId
                );


            const pageIndex =
                Number.isInteger(
                    data.pageIndex
                )
                    ? data.pageIndex
                    : board.currentPage;


            if (
                !board.pages[pageIndex]
            ) {

                return;

            }


            board.pages[
                pageIndex
            ].objects =
                board.pages[
                    pageIndex
                ].objects.filter(
                    object =>
                        object.id !==
                        data.objectId
                );


            board.updatedAt =
                Date.now();

            persistBoardState(socket.boardId);


            socket.to(
                socket.boardId
            ).emit(
                "object-delete",
                {

                    objectId:
                        data.objectId,

                    pageIndex

                }
            );

        }
    );


    // ========================================================
    // PAGE CHANGE
    // ========================================================

    socket.on(
        "page-change",
        (data) => {

            if (!socket.boardId) {
                return;
            }


            const pageIndex =
                Number.isInteger(
                    data?.pageIndex
                )
                    ? data.pageIndex
                    : 0;


            const board =
                getBoard(
                    socket.boardId
                );


            if (
                pageIndex < 0 ||
                pageIndex >= board.pages.length
            ) {

                return;

            }


            board.currentPage =
                pageIndex;

            board.updatedAt =
                Date.now();

            persistBoardState(socket.boardId);


            socket.to(
                socket.boardId
            ).emit(
                "page-change",
                {

                    pageIndex

                }
            );

        }
    );


    // ========================================================
    // PAGE ADD
    // ========================================================

    socket.on(
        "page-add",
        (data) => {

            if (!socket.boardId) {
                return;
            }


            const board =
                getBoard(
                    socket.boardId
                );


            const page =
                {

                    id:
                        `page-${Date.now()}-${Math.random()
                            .toString(36)
                            .slice(2, 8)}`,

                    height:
                        Number(data?.height) || 700,

                    drawings: [],

                    objects: []

                };


            board.pages.push(
                page
            );


            board.currentPage =
                board.pages.length - 1;


            board.updatedAt =
                Date.now();

            persistBoardState(socket.boardId);


            socket.to(
                socket.boardId
            ).emit(
                "page-add",
                {

                    page,

                    pageIndex:
                        board.pages.length - 1

                }
            );

        }
    );


    // ========================================================
    // PAGE RESIZE / EXTEND
    // ========================================================

    socket.on(
        "page-resize",
        (data) => {

            if (!socket.boardId) {
                return;
            }


            const board =
                getBoard(
                    socket.boardId
                );


            const pageIndex =
                Number.isInteger(
                    data?.pageIndex
                )
                    ? data.pageIndex
                    : board.currentPage;


            const height =
                Number(data?.height);


            if (
                !Number.isFinite(height) ||
                height < 300 ||
                height > 100000
            ) {

                return;

            }


            if (
                !board.pages[pageIndex]
            ) {

                return;

            }


            board.pages[
                pageIndex
            ].height =
                height;


            board.updatedAt =
                Date.now();

            persistBoardState(socket.boardId);


            socket.to(
                socket.boardId
            ).emit(
                "page-resize",
                {

                    pageIndex,

                    height

                }
            );

        }
    );


    // ========================================================
    // CLEAR CANVAS
    // ========================================================

    socket.on(
        "canvas-clear",
        (data) => {

            if (!socket.boardId) {
                return;
            }


            const board =
                getBoard(
                    socket.boardId
                );


            const pageIndex =
                Number.isInteger(
                    data?.pageIndex
                )
                    ? data.pageIndex
                    : board.currentPage;


            if (
                !board.pages[pageIndex]
            ) {

                return;

            }


            board.pages[
                pageIndex
            ].drawings = [];


            board.updatedAt =
                Date.now();

            persistBoardState(socket.boardId);


            socket.to(
                socket.boardId
            ).emit(
                "canvas-clear",
                {

                    pageIndex

                }
            );

        }
    );


    // ========================================================
    // DISCONNECTING
    // ========================================================
    //
    // IMPORTANT:
    // Use "disconnecting", not "disconnect", because the
    // socket is still inside the room at this point.
    //

    socket.on(
        "disconnecting",
        () => {

            const boardId =
                socket.boardId;

            const username =
                socket.username ||
                "Unknown User";


            if (!boardId) {
                return;
            }


            // Get remaining users BEFORE socket leaves
            const room =
                io.sockets.adapter.rooms.get(
                    boardId
                );


            const remainingUsers = [];


            if (room) {

                for (const socketId of room) {

                    if (
                        socketId === socket.id
                    ) {
                        continue;
                    }


                    const userSocket =
                        io.sockets.sockets.get(
                            socketId
                        );


                    if (
                        userSocket?.username
                    ) {

                        remainingUsers.push(
                            userSocket.username
                        );

                    }

                }

            }


            console.log(
                `${username} left board ${boardId}`
            );


            console.log(
                "Remaining users:",
                remainingUsers
            );


            socket.to(
                boardId
            ).emit(
                "user-left",
                {

                    username,

                    userCount:
                        remainingUsers.length,

                    users:
                        remainingUsers

                }
            );

        }
    );


    // ========================================================
    // CURSOR MOVE & LEAVE SYNC
    // Relays one validated cursor event per movement to collaborators.
    // ========================================================

    socket.on(
        "cursor-move",
        (data) => {
            if (!socket.boardId || !data || typeof data !== "object") return;

            const x = Number(data.x);
            const y = Number(data.y);

            if (!Number.isFinite(x) || !Number.isFinite(y)) return;

            socket.to(
                socket.boardId
            ).emit(
                "cursor-move",
                {
                    socketId: socket.id,
                    username: socket.username || data.username || "Collaborator",
                    x,
                    y,
                    color: data.color || null,
                    visible: data.visible !== false
                }
            );
        }
    );

    socket.on(
        "cursor-leave",
        () => {
            if (!socket.boardId) return;

            socket.to(
                socket.boardId
            ).emit(
                "cursor-leave",
                {
                    socketId: socket.id,
                    username: socket.username
                }
            );
        }
    );

    socket.on(
        "user-profile-sync",
        (data) => {
            if (!socket.boardId || !data) return;
            socket.profileIdx = String(data.profileIdx || "1");
            socket.to(socket.boardId).emit("user-profile-sync", data);
        }
    );

    // ========================================================
    // DISCONNECT
    // ========================================================

    socket.on(
        "disconnect",
        (reason) => {

            console.log(
                `Socket disconnected: ${socket.id}`
            );

            console.log(
                "Reason:",
                reason
            );

            if (socket.boardId) {
                const users = getBoardUsers(socket.boardId);

                socket.to(
                    socket.boardId
                ).emit(
                    "user-left",
                    {
                        username: socket.username,
                        socketId: socket.id,
                        userCount: users.length,
                        users: users
                    }
                );

                socket.to(
                    socket.boardId
                ).emit(
                    "cursor-leave",
                    {
                        socketId: socket.id,
                        username: socket.username
                    }
                );
            }

        }
    );

});


// ============================================================
// SANITIZE PAGE ARRAY
// ============================================================

function sanitizePages(pages) {

    if (!Array.isArray(pages)) {

        return [
            {
                id: "page-1",
                height: 700,
                drawings: [],
                objects: []
            }
        ];

    }


    return pages.map(
        (page, index) => {

            const safePage =
                page &&
                typeof page === "object"
                    ? page
                    : {};


            const height =
                Number(safePage.height);


            return {

                id:
                    typeof safePage.id === "string"
                        ? safePage.id
                        : `page-${index + 1}`,

                height:
                    Number.isFinite(height)
                        ? Math.max(
                            300,
                            Math.min(
                                height,
                                100000
                            )
                        )
                        : 700,

                canvasData:
                    typeof safePage.canvasData === "string"
                        ? safePage.canvasData
                        : null,

                drawings:
                    Array.isArray(
                        safePage.drawings
                    )
                        ? safePage.drawings
                            .map(
                                sanitizeDrawing
                            )
                            .filter(Boolean)
                        : [],

                objects:
                    Array.isArray(
                        safePage.objects
                    )
                        ? safePage.objects
                            .map(
                                sanitizeObject
                            )
                            .filter(Boolean)
                        : []

            };

        }
    );

}


// ============================================================
// SANITIZE OBJECT
// ============================================================

function sanitizeObject(object) {

    if (
        !object ||
        typeof object !== "object"
    ) {

        return null;

    }


    const clean = {
        ...object
    };


    // --------------------------------------------------------
    // ID
    // --------------------------------------------------------

    if (
        typeof clean.id !== "string" ||
        !clean.id.trim()
    ) {

        clean.id =
            `object-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 9)}`;

    }


    // --------------------------------------------------------
    // OBJECT TYPE
    // --------------------------------------------------------

    if (
        typeof clean.type !== "string"
    ) {

        clean.type = "unknown";

    }


    // --------------------------------------------------------
    // POSITION
    // --------------------------------------------------------

    if (
        clean.x !== undefined
    ) {

        const x =
            Number(clean.x);

        clean.x =
            Number.isFinite(x)
                ? x
                : 0;

    }


    if (
        clean.y !== undefined
    ) {

        const y =
            Number(clean.y);

        clean.y =
            Number.isFinite(y)
                ? y
                : 0;

    }


    return clean;

}


// ============================================================
// SANITIZE COMPLETE BOARD
// ============================================================

function sanitizeBoardState(
    incoming,
    existingBoard
) {

    const board =
        createDefaultBoard(
            existingBoard.boardId
        );


    // --------------------------------------------------------
    // TITLE
    // --------------------------------------------------------

    if (
        typeof incoming.title === "string"
    ) {

        board.title =
            incoming.title;

    }


    // --------------------------------------------------------
    // CANVAS STYLE
    // --------------------------------------------------------

    const validStyles = [
        "blank",
        "grid",
        "dots",
        "lines"
    ];


    if (
        validStyles.includes(
            incoming.canvasStyle
        )
    ) {

        board.canvasStyle =
            incoming.canvasStyle;

    }


    // --------------------------------------------------------
    // CURRENT PAGE
    // --------------------------------------------------------

    if (
        Number.isInteger(
            incoming.currentPage
        )
    ) {

        board.currentPage =
            Math.max(
                0,
                incoming.currentPage
            );

    }


    // --------------------------------------------------------
    // PAGES
    // --------------------------------------------------------

    board.pages =
        sanitizePages(
            incoming.pages
        );


    if (
        board.currentPage >=
        board.pages.length
    ) {

        board.currentPage =
            board.pages.length - 1;

    }


    board.updatedAt =
        Date.now();


    return board;

}


// ============================================================
// START SERVER
// ============================================================

const PORT = 3000;


server.listen(
    PORT,
    () => {

        console.log(
            "============================================"
        );

        console.log(
            "        LIVE CANVAS SERVER"
        );

        console.log(
            "============================================"
        );

        console.log(
            `Server running at: http://localhost:${PORT}`
        );

        console.log(
            `Boards in memory: ${boards.size}`
        );

        console.log(
            "Socket.IO: READY"
        );

        console.log(
            "============================================"
        );

    }
);
