const { execSync } = require('child_process');
const fs = require('fs');
try {
    const out = execSync('npx tsc --noEmit --jsx react-native');
    fs.writeFileSync('C:/tmp/tsc_out.txt', out);
} catch (e) {
    fs.writeFileSync('C:/tmp/tsc_out.txt', e.stdout);
}
