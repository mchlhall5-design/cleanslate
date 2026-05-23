
async function firebaseLogin(){
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({prompt:"select_account"});
  setStatus("authStatus","Opening Firebase Google sign-in...");
  try {
    await signInWithRedirect(auth, provider);
  } catch(e){
    setStatus("authStatus","Firebase login error: " + (e.message || JSON.stringify(e)));
  }
}

setStatus("authStatus","App loaded. Tap Firebase Google sign-in.");
updateAuth();
updateStats();
renderSenders();
