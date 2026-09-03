// Login form: validates credentials against the server and starts the user session.
const loginBtn = document.getElementById("loginBtn");
const passwordInput = document.getElementById("password");
const togglePassword = document.getElementById("togglePassword");
const eyeIcon = document.getElementById("eyeIcon");

togglePassword.addEventListener("click", () => {
    if (passwordInput.type === "password") {
        passwordInput.type = "text";
        eyeIcon.src = "assets/eye.png";
        eyeIcon.alt = "Hide password";
    } else {
        passwordInput.type = "password";
        eyeIcon.src = "assets/eye-off.png";
        eyeIcon.alt = "Show password";
    }
});

// Displays validation and authentication feedback next to the form.
function setFormMessage(message, type = "error") {
    const messageBox = document.getElementById("formMessage");
    if (!messageBox) return;

    messageBox.textContent = message;
    messageBox.className = `form-message ${type}`;
}

// Submits the login form only when the page includes its button.
if (loginBtn) {

    loginBtn.addEventListener("click", async function () {

        const email =
            document.getElementById("email").value.trim();

        const password =
            document.getElementById("password").value.trim();

        if (email === "" || password === "") {
            setFormMessage("Please enter email and password.");
            return;
        }

        loginBtn.disabled = true;
        loginBtn.textContent = "Logging in...";

        try {
            const res = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ email, password })
            });

            const data = await res.json();

            if (!res.ok) {
                setFormMessage(data.error || "Login failed.");
                return;
            }

            const params = new URLSearchParams(window.location.search);
            const redirect = params.get("redirect") || "saved.html";
            window.location.href = redirect;

        } catch (err) {
            console.error("Login error:", err);
            setFormMessage("Could not connect to server. Please try again.");
        } finally {
            loginBtn.disabled = false;
            loginBtn.textContent = "Log In";
        }

    });

}
