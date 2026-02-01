
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const newVersion = args[0];

if (!newVersion) {
    console.error('Usage: bun run scripts/bump.ts <new-version>');
    process.exit(1);
}

// 1. Update package.json
const packageJsonPath = path.join(process.cwd(), 'package.json');
try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    console.log(`Updating package.json: ${pkg.version} -> ${newVersion}`);
    pkg.version = newVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
} catch (e) {
    console.error('Failed to update package.json:', e);
    process.exit(1);
}

// 2. Update Dockerfile
const dockerfilePath = path.join(process.cwd(), 'Dockerfile');
try {
    let dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    const versionRegex = /LABEL org.opencontainers.image.version="([^"]+)"/;
    
    if (dockerfile.match(versionRegex)) {
        console.log(`Updating Dockerfile version label to ${newVersion}`);
        dockerfile = dockerfile.replace(versionRegex, `LABEL org.opencontainers.image.version="${newVersion}"`);
        fs.writeFileSync(dockerfilePath, dockerfile);
    } else {
        console.warn('Could not find version label in Dockerfile to update.');
    }
} catch (e) {
    console.error('Failed to update Dockerfile:', e);
    process.exit(1);
}

console.log(`\nSuccessfully bumped version to ${newVersion} 🚀`);
console.log('Don\'t forget to:');
console.log(`  git add .`);
console.log(`  git commit -m "chore: release ${newVersion}"`);
console.log(`  git tag ${newVersion}`);
console.log(`  git push --tags`);
