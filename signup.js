// Signup form: validates a new account, stores it in NeonDB, and starts a session.
const signupBtn = document.getElementById("signupBtn");
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

// Displays validation feedback next to the registration form.
function setFormMessage(message, type = "error") {
    const messageBox = document.getElementById("formMessage");
    if (!messageBox) return;

    messageBox.textContent = message;
    messageBox.className = `form-message ${type}`;
}

// Validates and creates the account when the registration form is submitted.
signupBtn.addEventListener("click", async function () {
    const name =
            document.getElementById("name")
                .value
                .trim();
    const email = document.getElementById("email").value.trim();

    const password = document.getElementById("password").value.trim();

    if (name ==="" || email === "" || password === "") {
        setFormMessage("Please fill all fields.");
        return;
    }
    if (name.trim().length < 3 || !/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(name.trim())) {
        setFormMessage("Name must be at least 3 characters and contain only alphabets and spaces.");
        return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setFormMessage("Please enter a valid email address.");
        return;
    }
    if (
    password.length < 8 ||
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[!@#$%^&*(),.?":{}|<>]/.test(password)
) {
    setFormMessage(
        "Password must be at least 8 characters and include uppercase, lowercase, number, and special character."
    );
    return;
}

    signupBtn.disabled = true;
    signupBtn.textContent = "Creating account...";

    try {
        const res = await fetch(window.LIVE_CANVAS_CONFIG.apiUrl('/api/auth/signup'), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ name, email, password })
        });

        let data = {};
        try {
            data = await res.json();
        } catch (jsonErr) {
            setFormMessage("Server returned unexpected response (status " + res.status + ").");
            return;
        }

        if (!res.ok) {
            setFormMessage(data.error || "Signup failed.");
            return;
        }

        const params = new URLSearchParams(window.location.search);
        const redirect = params.get("redirect") || "saved.html";
        window.location.href = redirect;

    } catch (err) {
        console.error("Signup error:", err);
        setFormMessage("Could not connect to server. Please try again.");
    } finally {
        signupBtn.disabled = false;
        signupBtn.textContent = "Sign Up";
    }
});
