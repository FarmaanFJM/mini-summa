// Run with:  node --test scripts/gradle-network.test.mjs      (from apps/android)
// The sample lines are copied from real Gradle 9.4.1 output of failed builds; they name only public Maven URLs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeUrl, explainDownloadFailure, isTransient, newEvidence, scanLine } from './gradle-network.mjs';

const feed = (text) => {
  const ev = newEvidence();
  for (const line of text.split('\n')) scanLine(line, ev);
  return ev;
};

const FRESCO = ['fresco', 'imagepipeline', 'imagepipeline-base', 'imagepipeline-okhttp3', 'imagepipeline-native', 'middleware', 'ui-common', 'ui-core', 'fbcore', 'drawee', 'memory-type-java', 'nativeimagefilters'];
const frescoLines = (status = 429) => FRESCO.map((a) => `         > Could not GET 'https://repo.maven.apache.org/maven2/com/facebook/fresco/${a}/3.7.0/${a}-3.7.0.aar'. Received status code ${status} from server: Too Many Requests`).join('\n');

test('a GET refused with 429 is remembered with its URL and counts as transient', () => {
  const ev = feed(frescoLines());
  assert.equal(ev.refused.size, 12);
  assert.equal([...ev.refused.values()][0].status, 429);
  assert.equal(isTransient(ev), true);
});

test('a HEAD refused with 429 (what POM lookups print) is recognised too', () => {
  const ev = feed("               > Could not HEAD 'https://repo.maven.apache.org/maven2/com/android/zipflinger/9.2.1/zipflinger-9.2.1.pom'. Received status code 429 from server: Too Many Requests");
  assert.equal(ev.refused.size, 1);
  assert.equal(describeUrl([...ev.refused.values()][0].url).kind, 'metadata');
});

test('Gradle prints each failure more than once; it is counted once', () => {
  const ev = feed(`${frescoLines()}\n${frescoLines()}`);
  assert.equal(ev.refused.size, 12);
});

test('a 404 or 403 is not transient, and neither is a compile error', () => {
  assert.equal(isTransient(feed("> Could not GET 'https://dl.google.com/dl/android/maven2/a/b/1.0/b-1.0.pom'. Received status code 404 from server: Not Found")), false);
  assert.equal(isTransient(feed("> Could not GET 'https://repo.maven.apache.org/maven2/a/b/1.0/b-1.0.jar'. Received status code 403 from server: Forbidden")), false);
  assert.equal(isTransient(feed("e: file:///x/MainActivity.kt:12:5 Unresolved reference: foo\n> Task :app:compileReleaseKotlin FAILED")), false);
});

test('a 503 and a dropped connection are transient', () => {
  assert.equal(isTransient(feed("> Could not GET 'https://plugins.gradle.org/m2/a/b/1.0/b-1.0.pom'. Received status code 503 from server: Service Unavailable")), true);
  assert.equal(isTransient(feed('> Could not GET .... Connect to repo.maven.apache.org:443 [repo.maven.apache.org/1.2.3.4] failed: Read timed out')), true);
  assert.equal(isTransient(feed('Caused by: java.net.SocketException: Connection reset')), true);
});

test('a certificate problem is reported as a trust problem, not as something to retry', () => {
  const ev = feed('javax.net.ssl.SSLHandshakeException: PKIX path building failed: sun.security.provider.certpath.SunCertPathBuilderException: unable to find valid certification path');
  assert.equal(ev.tls, true);
  assert.equal(isTransient(ev), false);
  assert.match(explainDownloadFailure(ev), /do not turn verification off/);
});

test('describeUrl names the registry and shortens the path', () => {
  assert.deepEqual(describeUrl('https://repo.maven.apache.org/maven2/com/facebook/fresco/fresco/3.7.0/fresco-3.7.0.aar'),
    { registry: 'Maven Central', host: 'repo.maven.apache.org', file: 'com/facebook/fresco/fresco/3.7.0/fresco-3.7.0.aar', kind: 'library' });
  assert.equal(describeUrl('https://dl.google.com/dl/android/maven2/androidx/exifinterface/exifinterface/1.4.2/exifinterface-1.4.2.aar').registry, 'Google Maven');
  assert.equal(describeUrl('https://dl.google.com/dl/android/maven2/androidx/exifinterface/exifinterface/1.4.2/exifinterface-1.4.2.aar').file, 'androidx/exifinterface/exifinterface/1.4.2/exifinterface-1.4.2.aar');
  assert.equal(describeUrl('https://www.jitpack.io/com/github/x/y/1.0/y-1.0.pom').registry, 'JitPack');
  assert.equal(describeUrl('https://plugins.gradle.org/m2/a/b/1.0/b-1.0.module').kind, 'metadata');
  assert.equal(describeUrl('https://example.org/some/file.jar').registry, 'example.org');
});

test('the explanation for twelve refused Fresco libraries names the server, the status and the way forward', () => {
  const text = explainDownloadFailure(feed(frescoLines()));
  assert.match(text, /HTTP 429 Too Many Requests from Maven Central \(repo\.maven\.apache\.org\): 12 file\(s\), 12 library, 0 metadata/);
  assert.match(text, /com\/facebook\/fresco\/fresco\/3\.7\.0\/fresco-3\.7\.0\.aar/);
  assert.match(text, /\.\.\. and 7 more/);
  assert.match(text, /throttling your network address/);
  assert.match(text, /continues where it stopped/);
  assert.match(text, /central\.sonatype\.org\/faq\/429-error/);
});

test('the Maven Central advice is only given when Maven Central was the one that refused', () => {
  const text = explainDownloadFailure(feed("> Could not GET 'https://dl.google.com/dl/android/maven2/c/d/2.0/d-2.0.aar'. Received status code 429 from server: Too Many Requests"));
  assert.match(text, /HTTP 429 Too Many Requests from Google Maven/);
  assert.doesNotMatch(text, /sonatype/);
});

test('refusals from different servers are listed separately', () => {
  const text = explainDownloadFailure(feed([
    "> Could not GET 'https://repo.maven.apache.org/maven2/a/b/1.0/b-1.0.pom'. Received status code 429 from server: Too Many Requests",
    "> Could not GET 'https://dl.google.com/dl/android/maven2/c/d/2.0/d-2.0.aar'. Received status code 503 from server: Service Unavailable",
  ].join('\n')));
  assert.match(text, /HTTP 429 Too Many Requests from Maven Central/);
  assert.match(text, /HTTP 503 Service Unavailable from Google Maven/);
});
