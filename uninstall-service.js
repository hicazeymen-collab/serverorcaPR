const Service = require('node-windows').Service;
const path = require('path');

// Create a service object
const svc = new Service({
  name: 'Orca Render Server',
  script: path.join(__dirname, 'server.js')
});

// Listen for the "uninstall" event
svc.on('uninstall', function(){
  console.log('✓ Service uninstalled successfully!');
  console.log('✓ Service no longer exists:', !svc.exists);
});

svc.on('error', function(err){
  console.error('✗ Error:', err);
});

// Uninstall the service
console.log('Uninstalling Orca Render Server...');
svc.uninstall();
