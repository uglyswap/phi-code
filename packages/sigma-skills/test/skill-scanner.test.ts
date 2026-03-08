import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { SkillScanner } from '../src/scanner.js';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { SkillsConfig } from '../src/types.js';

describe('SkillScanner', () => {
  let scanner: SkillScanner;
  let tempDir: string;
  let globalDir: string;
  let projectDir: string;
  let bundledDir: string;

  beforeEach(() => {
    // Create temporary test directories
    tempDir = join(process.cwd(), 'test-skills-' + Date.now());
    globalDir = join(tempDir, 'global');
    projectDir = join(tempDir, 'project');
    bundledDir = join(tempDir, 'bundled');
    
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(bundledDir, { recursive: true });
    
    const config: SkillsConfig = {
      globalDir,
      projectDir,
      bundledDir
    };
    
    scanner = new SkillScanner(config);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('scan should find skills in all directories', () => {
    // Create test skills in different directories
    createTestSkill(globalDir, 'global-skill', 'A skill from global directory');
    createTestSkill(projectDir, 'project-skill', 'A skill from project directory');
    createTestSkill(bundledDir, 'bundled-skill', 'A skill from bundled directory');
    
    const skills = scanner.scan();
    
    assert.equal(skills.length, 3);
    
    const skillNames = skills.map(s => s.name);
    assert(skillNames.includes('global-skill'));
    assert(skillNames.includes('project-skill'));
    assert(skillNames.includes('bundled-skill'));
  });

  test('scan should handle non-existent directories gracefully', () => {
    // Scanner with non-existent directories
    const config: SkillsConfig = {
      globalDir: '/non/existent/global',
      projectDir: '/non/existent/project',
      bundledDir: '/non/existent/bundled'
    };
    
    const nonExistentScanner = new SkillScanner(config);
    const skills = nonExistentScanner.scan();
    
    assert.equal(skills.length, 0);
  });

  test('loadSkill should parse SKILL.md correctly', () => {
    const skillContent = `# Weather Skill

Get current weather and forecasts via wttr.in or Open-Meteo.

## When to use

Use when user asks about weather, temperature, or forecasts for any location.

## Features

- Current weather data
- Temperature readings  
- Forecast information

## Usage

\`\`\`bash
weather london
\`\`\`
`;

    createTestSkillWithContent(globalDir, 'weather', skillContent);
    
    const skill = scanner.loadSkill(join(globalDir, 'weather'));
    
    assert(skill !== null);
    assert.equal(skill.name, 'weather');
    assert(skill.description.includes('Get current weather and forecasts'));
    assert.equal(skill.content, skillContent);
    assert(skill.path.endsWith('weather'));
    assert(Array.isArray(skill.keywords));
    assert(Array.isArray(skill.files));
  });

  test('loadSkill should return null for directory without SKILL.md', () => {
    const skillDir = join(globalDir, 'incomplete-skill');
    mkdirSync(skillDir, { recursive: true });
    // Don't create SKILL.md
    
    const skill = scanner.loadSkill(skillDir);
    
    assert.equal(skill, null);
  });

  test('extractKeywords should extract from headers', () => {
    const content = `# Weather API Integration

## Temperature Monitoring

### Forecast Analysis

Content here...
`;
    
    const keywords = (scanner as any).extractKeywords(content);
    
    assert(keywords.includes('weather'));
    assert(keywords.includes('api'));
    assert(keywords.includes('integration'));
    assert(keywords.includes('temperature'));
    assert(keywords.includes('monitoring'));
    assert(keywords.includes('forecast'));
    assert(keywords.includes('analysis'));
  });

  test('extractKeywords should extract from "when to use" sections', () => {
    const content = `# Test Skill

Description here.

## When to use

Use when you need to debug applications, fix errors, or troubleshoot issues.

## Usage

More content...
`;
    
    const keywords = (scanner as any).extractKeywords(content);
    
    assert(keywords.includes('debug'));
    assert(keywords.includes('applications'));
    assert(keywords.includes('fix'));
    assert(keywords.includes('errors'));
    assert(keywords.includes('troubleshoot'));
    assert(keywords.includes('issues'));
  });

  test('extractKeywords should extract from bullet points', () => {
    const content = `# API Skill

Description here.

## Features

- HTTP requests
- JSON parsing  
- Authentication handling
- Rate limiting
- Error recovery

## Tasks

* Database queries
* Data transformation
* Caching mechanisms
`;
    
    const keywords = (scanner as any).extractKeywords(content);
    
    assert(keywords.includes('http'));
    assert(keywords.includes('requests'));
    assert(keywords.includes('json'));
    assert(keywords.includes('parsing'));
    assert(keywords.includes('authentication'));
    assert(keywords.includes('handling'));
    assert(keywords.includes('rate'));
    assert(keywords.includes('limiting'));
    assert(keywords.includes('database'));
    assert(keywords.includes('queries'));
    assert(keywords.includes('transformation'));
    assert(keywords.includes('caching'));
    assert(keywords.includes('mechanisms'));
  });

  test('extractKeywords should filter out short words and stop words', () => {
    const content = `# The API

Use when you are debugging the code and fixing it for the user.

- API calls
- Get data  
- Set values
`;
    
    const keywords = (scanner as any).extractKeywords(content);
    
    // Short words and stop words should be filtered out
    assert(!keywords.includes('the'));
    assert(!keywords.includes('you'));
    assert(!keywords.includes('are'));
    assert(!keywords.includes('and'));
    assert(!keywords.includes('for'));
    assert(!keywords.includes('it'));
    
    // Meaningful words should be kept
    assert(keywords.includes('api'));
    assert(keywords.includes('debugging'));
    assert(keywords.includes('code'));
    assert(keywords.includes('fixing'));
    assert(keywords.includes('calls'));
    assert(keywords.includes('data'));
    assert(keywords.includes('values'));
  });

  test('extractKeywords should handle special characters and punctuation', () => {
    const content = `# REST-API & JSON/XML Processing!

## When to use:

Use when working with REST APIs, JSON/XML data, HTTP(S) requests.

- GET/POST/PUT requests
- OAuth2.0 authentication
- Rate-limiting (429 errors)
`;
    
    const keywords = (scanner as any).extractKeywords(content);
    
    assert(keywords.includes('rest'));
    assert(keywords.includes('api'));
    assert(keywords.includes('json'));
    assert(keywords.includes('xml'));
    assert(keywords.includes('processing'));
    assert(keywords.includes('working'));
    assert(keywords.includes('apis'));
    assert(keywords.includes('data'));
    assert(keywords.includes('http'));
    assert(keywords.includes('requests'));
    assert(keywords.includes('get'));
    assert(keywords.includes('post'));
    assert(keywords.includes('put'));
    assert(keywords.includes('oauth'));
    assert(keywords.includes('authentication'));
    assert(keywords.includes('rate'));
    assert(keywords.includes('limiting'));
    assert(keywords.includes('errors'));
  });

  test('getSkillFiles should list files in skill directory', () => {
    const skillDir = join(globalDir, 'test-skill');
    mkdirSync(skillDir, { recursive: true });
    
    // Create some test files
    writeFileSync(join(skillDir, 'SKILL.md'), 'skill content');
    writeFileSync(join(skillDir, 'script.py'), 'python script');
    writeFileSync(join(skillDir, 'config.json'), 'configuration');
    writeFileSync(join(skillDir, '.hidden'), 'hidden file');
    
    const files = (scanner as any).getSkillFiles(skillDir);
    
    assert(files.includes('SKILL.md'));
    assert(files.includes('script.py'));
    assert(files.includes('config.json'));
    assert(!files.includes('.hidden')); // Hidden files should be excluded
  });

  test('scan should handle skills with different content structures', () => {
    // Skill with minimal content
    createTestSkillWithContent(globalDir, 'minimal', '# Minimal\nBasic skill.');
    
    // Skill with complex content
    createTestSkillWithContent(projectDir, 'complex', `# Complex Skill

This is a complex skill with multiple sections.

## When to use

Use when you need complex processing, data analysis, or machine learning.

## Features

- Data processing
- Algorithm implementation  
- Performance optimization

## Examples

\`\`\`python
def process_data(data):
    return transformed_data
\`\`\`

## Notes

Additional notes and documentation here.
`);
    
    const skills = scanner.scan();
    
    assert.equal(skills.length, 2);
    
    const minimal = skills.find(s => s.name === 'minimal');
    const complex = skills.find(s => s.name === 'complex');
    
    assert(minimal !== undefined);
    assert(complex !== undefined);
    
    assert.equal(minimal.description, 'Basic skill.');
    assert(complex.description.includes('complex skill'));
    
    // Complex skill should have more keywords
    assert(complex.keywords.length > minimal.keywords.length);
  });

  // Helper functions
  function createTestSkill(dir: string, name: string, description: string) {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    
    const skillContent = `# ${name}

${description}

## When to use

Use when testing the ${name} functionality.

## Features

- Feature 1
- Feature 2
`;
    
    writeFileSync(join(skillDir, 'SKILL.md'), skillContent);
  }

  function createTestSkillWithContent(dir: string, name: string, content: string) {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), content);
  }
});