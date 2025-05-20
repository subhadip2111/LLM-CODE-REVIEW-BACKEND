// index.js
const express = require("express");
const multer = require("multer");
const unzipper = require("unzipper");
const fs = require("fs-extra");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config()
const app = express();
app.use(express.json());

// ================== Google Generative AI Setup ==================
console.log("[Init] Setting up Google Generative AI...");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Replace with your API key
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash"
});
console.log("[Init] Gemini model initialized.");

// ================== Multer Setup ==================
const upload = multer({ dest: "uploads/" });

// ================== Helper: Recursively Read Files ==================
async function getAllFilePaths(dirPath) {
  let filePaths = [];
  const files = await fs.readdir(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      const subPaths = await getAllFilePaths(fullPath);
      filePaths = filePaths.concat(subPaths);
    } else {
      filePaths.push(fullPath);
    }
  }
  return filePaths;
}

// ================== Helper: Function Name Extractor ==================
function extractFunctionNames(code) {
  const regex = /function\s+(\w+)|const\s+(\w+)\s*=\s*\(.*?\)\s*=>/g;
  const names = [];
  let match;
  while ((match = regex.exec(code))) {
    names.push(match[1] || match[2]);
  }
  return names;
}

// ================== Helper: Ask Gemini ==================
async function askGeminiAI(prompt) {
  try {
    console.log("[Gemini] Sending prompt to Gemini AI...");
    const result = await model.generateContent(prompt);
    console.log("[Gemini] Received response from Gemini AI.");
    return result.response.text();
  } catch (err) {
    console.error("Gemini Error:", err.message);
    return "[Gemini API Error]";
  }
}

// ================== Review Endpoint ==================
app.post("/review", upload.single("zipFile"), async (req, res) => {
  const prompt = req.body.prompt || "You are a senior backend reviewer.";
  const zipPath = req.file.path;
  const extractPath = `extracted/${Date.now()}`;

  try {
    console.log("[Review] Creating extraction directory...");
    await fs.mkdir(extractPath, { recursive: true });
    console.log("[Review] Extracting uploaded zip file...");
    await fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractPath }))
      .promise();

    console.log("[Review] Getting all file paths from extracted folder...");
    const allFiles = await getAllFilePaths(extractPath);
    const relevantFiles = allFiles.filter(f => [".js", ".ts", ".json"].includes(path.extname(f)));

    console.log("[Review] Sorting files (package.json and entry points first)...");
    relevantFiles.sort((a, b) => {
      if (a.endsWith("package.json")) return -1;
      if (b.endsWith("package.json")) return 1;
      if (a.includes("index") || a.includes("main")) return -1;
      return 0;
    });

    const results = [];

    for (const filePath of relevantFiles) {
      console.log(`\n[Review] Analyzing file: ${filePath}`);
      const content = await fs.readFile(filePath, "utf-8");
      const functionNames = extractFunctionNames(content);

      const dynamicPrompt = `
${prompt}
Analyze the following file as a code reviewer:

Filename: ${path.relative(extractPath, filePath)}

---
${content}
---

Respond with:
1. Structure issues
2. Logical mistakes
3. Naming issues
4. Design pattern (MVC or not)
5. Suggestions for improvements
6. Unused variables or packages
7. List of function names in the file 
`;

      const feedback = await askGeminiAI(dynamicPrompt);

      results.push({
        file: path.relative(extractPath, filePath),
        functions: functionNames,
        feedback,
      });
    }

    console.log("[Review] All files analyzed. Sending response to client.");
    res.json({
      message: "Code Review Completed",
      summary: results,
    });

    await fs.remove(zipPath);
    await fs.remove(extractPath);
    console.log("[Cleanup] Temporary files removed.");
  } catch (err) {
    console.error("Review Error:", err.message);
    res.status(500).json({ error: "Something went wrong during review" });
  }
});

// ================== Start Server ==================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
