const Service = require('node-windows').Service;
const path = require('path');

// Create a new service object
const svc = new Service({
  name: 'Orca Render Server',
  description: 'Orca Render Server - Handles video rendering jobs and uploads to Google Cloud Storage',
  script: path.join(__dirname, 'server.js'),
  nodeOptions: [
    '--harmony',
    '--max_old_space_size=4096'
  ],
  env: [{
    name: "NODE_ENV",
    value: "production"
  }]
});

// Listen for the "install" event
svc.on('install', function(){
  console.log('✓ Service installed successfully!');
  console.log('✓ Starting service...');
  svc.start();
});

svc.on('alreadyinstalled', function(){
  console.log('⚠ Service is already installed.');
  console.log('To reinstall, run uninstall-service.js first.');
});

svc.on('start', function(){
  console.log('✓ ' + svc.name + ' started successfully!');
  console.log('✓ Server is now running on port 6068');
  console.log('\nYou can manage the service from:');
  console.log('- Windows Services (services.msc)');
  console.log('- Or use: net start/stop "Orca Render Server"');
});

svc.on('error', function(err){
  console.error('✗ Error:', err);
});

// Install the service
console.log('Installing Orca Render Server as a Windows Service...');
svc.install();
