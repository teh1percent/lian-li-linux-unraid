'use strict';
// Catches the Community Applications mistakes that a repository scan would reject.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const tag = (xml, name) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1].trim();
const RAW = 'https://raw.githubusercontent.com/teh1percent/lian-li-linux-unraid/main/';
const localFile = (url) => {
  assert.ok(url.startsWith(RAW), url);
  return url.slice(RAW.length);
};

test('there is one Docker template and its URL points at itself', () => {
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'templates')), ['lian-li-linux.xml']);
  const xml = read('templates/lian-li-linux.xml');
  assert.strictEqual(localFile(tag(xml, 'TemplateURL')), 'templates/lian-li-linux.xml');
  assert.ok(!fs.existsSync(path.join(root, 'unraid')), 'an old copy would be a second app with the same name');
});

test('the template has the fields reviewers look for', () => {
  const xml = read('templates/lian-li-linux.xml');
  for (const name of ['Name', 'Repository', 'Overview', 'Category', 'License']) assert.ok(tag(xml, name), name);
  assert.ok(fs.existsSync(path.join(root, localFile(tag(xml, 'Icon')))));
  assert.ok(fs.existsSync(path.join(root, localFile(tag(xml, 'ReadMe')))));
  assert.match(tag(xml, 'Support'), /teh1percent/, 'support goes to this package, not upstream');
  assert.ok(!/YOUR_|example-app|container_name/.test(xml), 'no starter placeholders');
  assert.strictEqual(xml.match(/<ExtraParams\/>/)?.length, 1, 'no extra docker arguments');
  assert.strictEqual(xml.match(/<PostArgs\/>/)?.length, 1, 'no commands after docker run');
  const targets = [...xml.matchAll(/<Config [^>]*Target="([^"]+)"/g)].map((match) => match[1]);
  assert.strictEqual(new Set(targets).size, targets.length, 'each setting has its own target');
  assert.ok(targets.includes('RESET_PASSWORD') && !targets.includes('WEB_PASSWORD'), 'the password is made on first visit');
  assert.ok(![...xml.matchAll(/Description="([^"]*)"/g)].some((match) => /[<>]|&lt;/.test(match[1])), 'descriptions must not look like HTML');
});

test('every screenshot and local link on the page and in the listing exists', () => {
  const listed = [...read('templates/lian-li-linux.xml').matchAll(/<Screenshot>([^<]+)<\/Screenshot>/g)].map((match) => localFile(match[1]));
  assert.ok(listed.length > 0);
  const readme = read('README.md');
  const local = [...readme.matchAll(/src="([^"]+)"/g), ...readme.matchAll(/\]\((?!http|#)([^)]+)\)/g)].map((match) => match[1]);
  assert.ok(local.length > 0);
  for (const file of [...listed, ...local]) assert.ok(fs.existsSync(path.join(root, file)), file);
});

test('the page links only to headings that exist', () => {
  const readme = read('README.md');
  const anchors = new Set([...readme.matchAll(/^#{1,6} (.+)$/gm)].map((match) => match[1].toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-')));
  for (const [, anchor] of readme.matchAll(/\]\(#([^)]+)\)/g)) assert.ok(anchors.has(anchor), anchor);
});

test('the repository files for the profile exist', () => {
  const xml = read('ca_profile.xml');
  assert.ok(tag(xml, 'Profile').length > 20);
  assert.ok(fs.existsSync(path.join(root, localFile(tag(xml, 'Icon')))));
  assert.match(read('LICENSE'), /^MIT License/);
  assert.match(read('README.md'), /sgtaziz\/lian-li-linux/);
});
