"use client";
import { Button } from "@/components/ui/button"
import { useState } from "react"
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export default function Home() {
  const {data: session} = authClient.useSession() 
  const [email,setEmail]=useState("");
  const [name,setName]=useState("");
  const [password,setPassword]=useState("");

  const onSubmit=()=>{
    authClient.signUp.email({
      email,
      name,
      password
    },{
      onError:()=>{
        window.alert("something went wrong")
      },
      onSuccess:()=>{
        window.alert("successful")
      }
    })
  }
    const onLogin=()=>{
    authClient.signIn.email({
      email,
      password
    },{
      onError:()=>{
        window.alert("something went wrong")
      },
      onSuccess:()=>{
        window.alert("successful")
      }
    })
  }
  if (session){
    return (<div>
      <p>Logged in as {session.user.name}</p>
      <Button onClick={()=>authClient.signOut()}>
        Sign Out
      </Button>
    </div>)
  }

  return (
    <div>
      <div>
        <Input placeholder="name" value={name} onChange={(e)=>setName(e.target.value)}/>
        <Input placeholder="email" value={email} onChange={(e)=>setEmail(e.target.value)}/>
        <Input placeholder="password" value={password} onChange={(e)=>setPassword(e.target.value)}/>
        <Button onClick={onSubmit}>Create User</Button>
      </div> 
      <div>
        <Input placeholder="email" value={email} onChange={(e)=>setEmail(e.target.value)}/>
        <Input placeholder="password" value={password} onChange={(e)=>setPassword(e.target.value)}/>
        <Button onClick={onLogin}>Login</Button>
      </div> 
    </div>
  )
}
