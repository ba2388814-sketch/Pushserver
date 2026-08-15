importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA1oGWkI4OyUtq1Oe-4a0i2u7oF_EkyvRk",
  authDomain: "pushserver-8159b.firebaseapp.com",
  projectId: "pushserver-8159b",
  storageBucket: "pushserver-8159b.firebasestorage.app",
  messagingSenderId: "1055841977627",
  appId: "1:1055841977627:web:c97d8cca69cec84bfe7fbe"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  const notificationTitle = payload.data?.title || 'নতুন নোটিফিকেশন';
  const notificationOptions = {
    body: payload.data?.body || '',
    icon: payload.data?.imageUrl || ''
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
