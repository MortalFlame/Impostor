// Example of reorganized server.js content with 'broadcast' function placed before invocations

function broadcast(message) {
    // Implementation of the broadcast function
    console.log(message);
}

// Other function declarations and code

function someOtherFunction() {
    // Invoke broadcast function
    broadcast('Hello, world!');
}

// Example server setup and other logic here