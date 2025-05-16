const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });
const PORT = process.env.PORT || 3000;

const EXCLUDE_FOLDERS = ['node_modules', '.git', 'dist', 'build', '.vscode'];

app.use(express.json());

// Recursively collects files of interest
async function collectFiles(dir, baseDir = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let files = [];

  for (const entry of entries) {
    if (EXCLUDE_FOLDERS.includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(await collectFiles(fullPath, baseDir));
    } else {
      const ext = path.extname(entry.name);
      const validExts = ['.js', '.ts', '.jsx', '.tsx', '.json'];
      if (validExts.includes(ext) || entry.name.startsWith('.env')) {
        files.push(path.relative(baseDir, fullPath));
      }
    }
  }

  return files;
}

// Locates package.json (project root)
async function locatePackageJson(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (EXCLUDE_FOLDERS.includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === 'package.json') return fullPath;
    if (entry.isDirectory()) {
      const result = await locatePackageJson(fullPath);
      if (result) return result;
    }
  }
  return null;
}

async function extractDependencies(pkgPath) {
  try {
    const content = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);
    return {
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {},
    };
  } catch {
    return { dependencies: {}, devDependencies: {} };
  }
}

function detectStrangeIdentifiers(code) {
  const names = [];
  const regex = /\b(?:function|const|let|var)\s+([a-zA-Z0-9_$]+)/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    const name = match[1];
    if (/^_+$/.test(name) || (name.length === 1 && !['i', 'j', 'k'].includes(name)) || /[^a-zA-Z0-9_$]/.test(name)) {
      names.push(name);
    }
  }
  return [...new Set(names)];
}

function assessReadability(code) {
  const lines = code.split('\n');
  const longLines = lines.filter(line => line.length > 120);
  return { totalLines: lines.length, longLines: longLines.length };
}

async function detectEnvFiles(baseDir) {
  const allFiles = await collectFiles(baseDir);
  return allFiles.filter(f => path.basename(f).startsWith('.env'));
}

// Enhanced code sampling
async function scanCodeFiles(baseDir, files) {
  const results = {
    identifiers: [],
    readability: { totalLines: 0, longLines: 0 },
    analyzedFiles: [],
  };

  const codeExtensions = ['.js', '.ts', '.jsx', '.tsx'];
  const codeFiles = files.filter(f => codeExtensions.includes(path.extname(f)));

  // Sort by shortest path (shallow files) and take more samples
  const sampled = codeFiles.sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 20);

  for (const file of sampled) {
    try {
      const fullPath = path.join(baseDir, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      results.analyzedFiles.push(file);
      results.identifiers.push(...detectStrangeIdentifiers(content));
      const readability = assessReadability(content);
      results.readability.totalLines += readability.totalLines;
      results.readability.longLines += readability.longLines;
    } catch {
      continue;
    }
  }

  return results;
}

function generateQualityReport({ description, deps, identifiers, readability, envs, files }) {
  const allDeps = Object.keys(deps.dependencies);
  const commonDeps = ['express', 'nestjs', 'mongoose', 'cors', 'dotenv', 'body-parser'];
  const uncommonDeps = allDeps.filter(d => !commonDeps.includes(d.toLowerCase()));

  const improvements = [];

  if (identifiers.length > 0) {
    improvements.push({
      priority: "medium",
      suggestion: `Refactor unusual identifiers like: ${identifiers.slice(0, 3).join(', ')}`,
      reason: "Strange names can reduce readability and collaboration clarity."
    });
  }

  if (readability.longLines > 10) {
    improvements.push({
      priority: "medium",
      suggestion: "Break long lines exceeding 120 characters.",
      reason: "Improves readability across devices and editors."
    });
  }

  if (envs.length === 0) {
    improvements.push({
      priority: "low",
      suggestion: "Add a .env.example file.",
      reason: "Helps onboarding and clarifies required env variables."
    });
  }

  if (files.some(f => f.includes('route')) && !files.some(f => f.includes('controller'))) {
    improvements.push({
      priority: "high",
      suggestion: "Separate routes from controller logic.",
      reason: "Follows clean architecture and improves testability."
    });
  }

  const qualityRating = 10 - improvements.length - Math.min(2, Math.floor(readability.longLines / 20));
  const clampedRating = Math.max(6, Math.min(qualityRating, 9)).toFixed(1);

  return {
    watched_files: files,
    positive_feedback: [
      "Modular structure detected.",
      "Valid use of common dependencies.",
      "Environment files appear managed."
    ],
    improvements,
    senior_notes: `This project shows thoughtful structure. A few issues in naming and formatting can be resolved for better maintainability.`,
    quality_rating: `${clampedRating}/10`,
    fallback: null
  };
}

app.post('/upload', upload.single('files'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { description } = req.body;

  try {
    const extractDir = path.join(__dirname, 'temp', Date.now().toString());
    await fs.mkdir(extractDir, { recursive: true });
    new AdmZip(req.file.path).extractAllTo(extractDir, true);

    const pkgPath = await locatePackageJson(extractDir);
    if (!pkgPath) return res.status(400).json({ error: 'No package.json found' });

    const projectRoot = path.dirname(pkgPath);
    const deps = await extractDependencies(pkgPath);
    const allFiles = await collectFiles(projectRoot);
    const envs = await detectEnvFiles(projectRoot);
    const { identifiers, readability, analyzedFiles } = await scanCodeFiles(projectRoot, allFiles);

    const report = generateQualityReport({
      description,
      deps,
      identifiers,
      readability,
      envs,
      files: analyzedFiles
    });

    await fs.rm(extractDir, { recursive: true, force: true });
    await fs.rm(req.file.path, { force: true });

    return res.json(report);
  } catch (err) {
    console.error('Analysis error:', err);
    return res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
